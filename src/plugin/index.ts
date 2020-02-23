import { writeFileSync } from 'fs';
import { join } from 'path';

import { addNamed } from '@babel/helper-module-imports';

import { transform as transformClassesToTypes } from '../config/transform-classes-to-types';
import { transform as transformConfigToClasses } from '../config/transform-config-to-classes';
import { IExtractedClass, IExtractedClasses } from '../types';
import { createClassObject, evaluateConfig, getUserConfig, injectDevelopment, injectProduction } from '../utils';

const cssPath = join(process.cwd(), 'node_modules', 'classy-ui', 'styles.css');
const config = evaluateConfig(getUserConfig());
const classes = transformConfigToClasses(config);

if (process.env.NODE_ENV !== 'test') {
  try {
    const esTypesPath = join(process.cwd(), 'node_modules', 'classy-ui', 'es', 'classy-ui.d.ts');
    const libTypesPath = join(process.cwd(), 'node_modules', 'classy-ui', 'lib', 'classy-ui.d.ts');
    const types = transformClassesToTypes(classes, config);

    writeFileSync(esTypesPath, types);
    writeFileSync(libTypesPath, types);
  } catch {
    // Codesandbox or some other unwritable environment
  }
}

export default (babel: any) => {
  return {
    name: 'classy-ui/plugin',
    visitor: {
      Program(programmPath: any, state: any) {
        programmPath.traverse({
          ImportDeclaration(path: any) {
            if (path?.node?.source?.value === 'classy-ui') {
              const imports = path.node.specifiers.map((s: any) => ({ local: s.local.name, name: s.imported.name }));

              const referencePaths = imports.reduce((aggr: any, { local, name }: { local: string; name: string }) => {
                const binding = path.scope.getBinding(local);
                if (binding && Boolean(binding.referencePaths.length)) {
                  aggr[name] = binding.referencePaths;
                }
                return aggr;
              }, {});

              processReferences(babel, state, referencePaths);
              path.remove();
            }
          },
        });
      },
    },
  };
};

export function processReferences(babel: any, state: any, refs: any) {
  const { types: t } = babel;
  const isProduction = babel.getEnv() === 'production';
  const classCollection: IExtractedClasses = {};

  refs['tokens'] && processTokens(refs['tokens'], isProduction);
  refs['t'] && processTokens(refs['t'], isProduction);

  refs['group'] && processGroup(refs['group']);
  refs['themes'] && processThemes(refs['themes']);

  refs['compose'] && processCompose(refs['compose']);
  refs['c'] && processCompose(refs['c']);

  if (isProduction) {
    writeFileSync(cssPath, injectProduction(classCollection, classes, config));
  } else {
    const runtimeCall = t.expressionStatement(
      t.callExpression(addNamed(state.file.path, 'addClasses', 'classy-ui/runtime'), [
        t.arrayExpression(injectDevelopment(classCollection, classes, config).map(value => t.stringLiteral(value))),
      ]),
    );

    state.file.ast.program.body.push(runtimeCall);
  }

  function collectGlobally(classObj: IExtractedClass) {
    if (classObj.uid) {
      classCollection[classObj.uid] = classObj;
    }
  }

  function convertToExpression(classAttribs: any[]) {
    if (classAttribs.length === 0) {
      return t.stringLiteral(' ');
    }

    let needsRuntime: boolean = false;
    const strings: string[] = [];
    const others: any[] = [];
    for (const item of classAttribs) {
      if (t.isStringLiteral(item)) {
        strings.push(item.value);
      } else {
        needsRuntime = true;
        others.push(item);
      }
    }

    // if there are only string literals just return them. This is a _short path_
    if (strings.length > 0 && others.length === 0) {
      return t.stringLiteral(strings.join(' ') + ' ');
    }

    const max = others.length - 1;
    let start = others[max];
    for (let i = max - 1; i >= 0; i--) {
      start = t.binaryExpression('+', others[i], start);
    }

    if (strings.length === 0) {
      return start;
    }

    start = t.binaryExpression('+', start, t.stringLiteral(strings.join(' ') + ' '));

    if (needsRuntime) {
      return t.callExpression(addNamed(state.file.path, 'fixSpecificity', 'classy-ui/runtime'), [start]);
    }

    return start;
  }

  function getImportName(name: string, scope: any) {
    const binding = scope.getBinding(name);
    if (binding && t.isImportSpecifier(binding.path.node) && binding.path.parent.source.value.startsWith('classy-ui')) {
      return binding.path.node.imported.name;
    }
    return null;
  }

  function processCompose(cRefs: any[]) {
    cRefs
      // Only use top-most class
      .filter((path: any) => {
        // path.node will always be an identifier
        // if path.parentPath.parent is a CallExpression
        // it's callee name must not be part of classy-ui to be allowed here

        if (t.isCallExpression(path.parentPath.parent)) {
          return getImportName(path.parentPath.parent.callee.name, path.scope) === null;
        }
        return true;
      })

      .forEach((path: any) => {
        const statementPath = path.parentPath;
        const args = statementPath.node.arguments;

        statementPath.replaceWith(convertToExpression(args));
      });
  }

  function processGroup(refs: any[]) {
    refs.forEach((ref: any) => {
      if (!t.isCallExpression(ref.parent)) {
        throw ref.buildCodeFrameError(`CLASSY-UI: group must be used inside compose`);
      }
      if (ref.parent.callee === ref.node) {
        throw ref.buildCodeFrameError(`CLASSY-UI: group should not be invoked`);
      }

      ref.replaceWith(t.stringLiteral(ref.node.name));
    });
  }

  function processThemes(refs: any[]) {
    refs.forEach((ref: any) => {
      if (t.isMemberExpression(ref.parent)) {
        const memberExpr = extractMemberExpression(ref);
        memberExpr.root.replaceWith(t.stringLiteral(ref.node.name + '-' + memberExpr.arr.join('-')));
      } else {
        throw ref.buildCodeFrameError(`CLASSY-UI: add the theme name here like themes.dark`);
      }
    });
  }

  function processTokens(tRefs: any[], isProduction: boolean) {
    tRefs.forEach((tRef: any) => {
      if (!t.isMemberExpression(tRef.parent)) {
        throw tRef.buildCodeFrameError(`CLASSY-UI: t/tokens can't be used without a base class`);
      }
      const memExpr = extractMemberExpression(tRef);
      if (memExpr.arr.length >= 2) {
        const [baseClass, token, ...decorators] = memExpr.arr;
        const classObject = createClassObject({ baseClass, token, decorators }, classes, isProduction);
        collectGlobally(classObject);
        memExpr.root.replaceWith(t.stringLiteral(classObject.name));
      } else {
        throw tRef.buildCodeFrameError(`CLASSY-UI: t/tokens must reference a base class and a token`);
      }
      return tRef;
    });
  }

  function extractMemberExpression(tRefPath: any) {
    let prev = tRefPath;
    let path = prev.parentPath;
    let arr = [];
    while (path.node.type === 'MemberExpression') {
      path.node.property && arr.push(path.node.property.name);
      prev = path;
      path = path.parentPath;
    }
    return {
      root: prev,
      arr,
    };
  }
}
