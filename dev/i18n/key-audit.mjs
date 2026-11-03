import ts from 'typescript';

const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const callName = node => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined;

// Binding symbols distinguish default t from an AgSDL t in another function.
export function auditTranslationKeys(content, filename, englishKeys) {
  const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true,
    filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const host = {
    getSourceFile: name => name === filename ? source : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '',
    getDirectories: () => [], fileExists: name => name === filename,
    readFile: () => undefined, getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const checker = ts.createProgram([filename], { noResolve: true, noLib: true }, host).getTypeChecker();
  const errors = [];
  const namespaceFor = expression => {
    if (!ts.isIdentifier(expression)) return 'translation';
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    let initializer = declaration?.initializer;
    if (declaration && ts.isBindingElement(declaration)) initializer = declaration.parent.parent.initializer;
    if (!initializer || !ts.isCallExpression(initializer)) return 'translation';
    const name = callName(initializer.expression);
    if (name === 'useAgsdlTranslation') return 'agsdl';
    if (name === 'useTranslation') return literal(initializer.arguments[0]) ?? 'translation';
    if (name === 'getFixedT') return literal(initializer.arguments[1]) ?? 'translation';
    return 'translation';
  };
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const declaration = ts.isIdentifier(node.expression) ? checker.getSymbolAtLocation(node.expression)?.valueDeclaration : undefined;
      const isTranslationAlias = declaration && ts.isBindingElement(declaration) &&
        (declaration.propertyName?.getText(source) ?? declaration.name.getText(source)) === 't';
      if (name === 't' || isTranslationAlias) {
        const argument = node.arguments[0];
        const dynamic = argument && ts.isTemplateExpression(argument);
        const key = dynamic ? argument.head.text.replace(/\.$/, '') : literal(argument);
        if (key) {
          let namespace = namespaceFor(node.expression);
          for (const options of node.arguments.slice(1)) {
            if (!ts.isObjectLiteralExpression(options)) continue;
            const ns = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source).replace(/['"]/g, '') === 'ns');
            if (ns) namespace = literal(ns.initializer) ?? namespace;
          }
          if (key.startsWith('agsdl.') && namespace !== 'agsdl') {
            errors.push(`uses ${key} with the default namespace; use the agsdl namespace`);
          }
          const exists = dynamic
            ? [...englishKeys.keys()].some(candidate => candidate.startsWith(`${key}.`))
            : englishKeys.has(key) || englishKeys.has(`${key}_one`) || englishKeys.has(`${key}_other`);
          if (!exists) errors.push(dynamic ? `references missing i18n subtree: ${key}` : `references missing i18n key: ${key}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(errors)];
}

export const isUntranslatedEnglish = (language, key, value, englishValue, allowlist) =>
  language !== 'en' && value === englishValue && allowlist[language]?.[key] !== englishValue;
