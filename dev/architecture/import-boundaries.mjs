#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { chatBoundaryViolations, isExtractedNativeFile, nativeBoundaryViolations } from './extracted-boundaries.mjs';

export const BASELINE_PATH = 'dev/architecture/import-boundaries.baseline.json';
export const SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx']);
export const EXCLUDED_SUFFIXES = Object.freeze(['.d.ts', '.test.ts', '.test.tsx']);

export const OWNERS = Object.freeze(['Chat', 'Tasks/Plans', 'Providers', 'Shell']);

export const EXPLICITLY_FORBIDDEN_EDGES = Object.freeze([
  Object.freeze({
    id: 'streaming-chat-to-architect-chat',
    from: 'src/services/streamingChat.ts',
    to: 'src/services/architectChat.ts',
    owner: 'Chat',
    reason: 'Resolved in this lot by moving the shared prompt contract to src/domains/chat/prompts.ts.',
  }),
  Object.freeze({
    id: 'architect-chat-to-plan-artifact-service',
    from: 'src/services/architectChat.ts',
    to: 'src/services/architectPlanArtifactService.ts',
    owner: 'Tasks/Plans',
    reason: 'Resolved in this lot by moving artifact contracts to src/domains/plans/artifactContracts.ts.',
  }),
  Object.freeze({
    id: 'i18n-to-toast-service',
    from: 'src/i18n/index.ts',
    to: 'src/components/ui/toastService.tsx',
    owner: 'Shell',
    reason: 'Resolved in this lot by routing language notifications through src/i18n/languageNotifications.ts.',
  }),
  Object.freeze({
    id: 'toast-service-to-app-store',
    from: 'src/components/ui/toastService.tsx',
    to: 'src/stores/useAppStore.ts',
    owner: 'Shell',
    reason: 'Resolved in this lot by injecting notification preferences and delivery services.',
  }),
]);

const RULES = Object.freeze([
  Object.freeze({
    id: 'services-to-stores-or-ui',
    label: 'services -> stores/UI',
    sourcePrefixes: ['src/services/'],
    targetPrefixes: ['src/stores/', 'src/components/', 'src/composition/'],
    kinds: ['runtime'],
  }),
  Object.freeze({
    id: 'models-to-application',
    label: 'models -> stores/UI/services/composition',
    sourcePrefixes: ['src/types/', 'src/domains/'],
    targetPrefixes: ['src/stores/', 'src/components/', 'src/services/', 'src/composition/'],
    kinds: ['runtime', 'type'],
  }),
]);

const TSX_SCRIPT_KIND = ts.ScriptKind.TSX;

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function isSourceFile(path) {
  const normalized = normalizePath(path);
  return SOURCE_EXTENSIONS.includes(extname(normalized)) && !EXCLUDED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function sourceFileNames(rootDirectory, sourceDirectory = 'src') {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(path);
      } else {
        const relativePath = normalizePath(relative(rootDirectory, path));
        if (entry.isSymbolicLink()) throw new Error(`Import guard requires regular source paths, found symlink: ${relativePath}`);
        files.push(relativePath);
      }
    }
  };
  const sourceRoot = join(rootDirectory, sourceDirectory);
  if (existsSync(sourceRoot)) walk(sourceRoot);
  return sorted(files);
}

function gitSourceFileNames(rootDirectory, ref) {
  const output = execFileSync('git', ['-C', rootDirectory, 'ls-tree', '-rz', ref, '--', 'src', 'src-tauri/src'], {
    encoding: 'utf8',
  });
  return sorted(output.split('\0').filter(Boolean).map((entry) => {
    const [metadata, path] = entry.split('\t');
    if (metadata.startsWith('120000')) throw new Error(`Import guard requires regular source paths, found symlink: ${path}`);
    return path;
  }));
}

function readGitFile(rootDirectory, ref, path) {
  return execFileSync('git', ['-C', rootDirectory, 'show', `${ref}:${path}`], { encoding: 'utf8' });
}

function createFilesystemReader(rootDirectory) {
  const resolutionFiles = sourceFileNames(rootDirectory);
  return {
    resolutionFiles,
    files: resolutionFiles.filter(isSourceFile),
    nativeFiles: sourceFileNames(rootDirectory, 'src-tauri/src').filter(isExtractedNativeFile),
    read(path) {
      return readFileSync(join(rootDirectory, path), 'utf8');
    },
  };
}

function createGitReader(rootDirectory, ref) {
  const allFiles = gitSourceFileNames(rootDirectory, ref);
  const resolutionFiles = allFiles.filter((path) => path.startsWith('src/'));
  return {
    resolutionFiles,
    files: resolutionFiles.filter(isSourceFile),
    nativeFiles: allFiles.filter(isExtractedNativeFile),
    read(path) {
      return readGitFile(rootDirectory, ref, path);
    },
  };
}

export function createVirtualReader(sources) {
  const normalizedSources = new Map(Object.entries(sources).map(([path, text]) => [normalizePath(path), text]));
  return {
    resolutionFiles: sorted([...normalizedSources.keys()].filter((path) => path.startsWith('src/'))),
    files: sorted([...normalizedSources.keys()].filter((path) => path.startsWith('src/') && isSourceFile(path))),
    nativeFiles: sorted([...normalizedSources.keys()].filter(isExtractedNativeFile)),
    read(path) {
      const text = normalizedSources.get(normalizePath(path));
      if (text === undefined && path === 'package.json') return '{}';
      if (text === undefined && path === 'vite.config.ts') {
        return readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
      }
      if (text === undefined) throw new Error(`Virtual source is missing: ${path}`);
      return text;
    },
  };
}

function scriptKindFor(path) {
  return path.endsWith('.tsx') ? TSX_SCRIPT_KIND : ts.ScriptKind.TS;
}

function diagnosticMessage(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function transpileSource(path, text) {
  const fileName = normalizePath(path);
  const result = ts.transpileModule(text, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return {
    diagnostics: (result.diagnostics ?? []).map(diagnosticMessage),
    outputText: result.outputText,
    sourceFile: ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName)),
  };
}

function namesForImportClause(clause) {
  if (!clause) return [];
  const names = [];
  if (clause.name) names.push(clause.name.text);
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
    else names.push(...clause.namedBindings.elements.map((element) => element.name.text));
  }
  return names;
}

function namesForExportClause(exportClause) {
  if (!exportClause || !ts.isNamedExports(exportClause)) return [];
  return exportClause.elements.map((element) => element.name.text);
}

function addImport(imports, source, kinds, line, lazy = false) {
  imports.push({ source, kinds: sorted(kinds), line, lazy });
}

function sourceImportEntries(sourceFile) {
  const entries = [];
  const unsupported = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const explicitType = Boolean(clause?.isTypeOnly || (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((element) => element.isTypeOnly)));
      entries.push({
        source: statement.moduleSpecifier.text,
        names: namesForImportClause(clause),
        explicitType,
        sideEffect: !clause,
        lazy: false,
        line: sourceFile.getLineAndCharacterOfPosition(statement.getStart()).line + 1,
      });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      entries.push({
        source: statement.moduleSpecifier.text,
        names: namesForExportClause(statement.exportClause),
        explicitType: Boolean(statement.isTypeOnly || (statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some((element) => element.isTypeOnly))),
        sideEffect: false,
        lazy: false,
        line: sourceFile.getLineAndCharacterOfPosition(statement.getStart()).line + 1,
      });
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression)) {
      entries.push({
        source: statement.moduleReference.expression.text,
        names: [statement.name.text],
        explicitType: false,
        sideEffect: false,
        lazy: false,
        forceRuntime: true,
        line: sourceFile.getLineAndCharacterOfPosition(statement.getStart()).line + 1,
      });
    }
  }
  const visit = (node) => {
    // These Vite transforms generate imports that transpileModule cannot expose.
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (['glob', 'globEager', 'globEagerDefault'].includes(name)) {
        unsupported.push(`Unsupported Vite import.meta.${name} at line ${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}.`);
      }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      entries.push({
        source: node.argument.literal.text,
        names: [],
        explicitType: true,
        sideEffect: false,
        lazy: false,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) {
        entries.push({
          source: argument.text,
          names: [],
          explicitType: false,
          sideEffect: false,
          lazy: true,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      } else {
        unsupported.push(`Unsupported non-literal dynamic import at line ${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}.`);
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
      if (argument && ts.isStringLiteral(argument)) {
        entries.push({
          source: argument.text,
          names: [],
          explicitType: false,
          sideEffect: false,
          lazy: false,
          forceRuntime: true,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      } else {
        unsupported.push(`Unsupported non-literal require at line ${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}.`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { entries, unsupported };
}

function outputRuntimeEntries(path, outputText) {
  const outputFileName = `${normalizePath(path).replace(/\.tsx?$/, '')}.js`;
  const sourceFile = ts.createSourceFile(outputFileName, outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const entries = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      entries.push({ source: statement.moduleSpecifier.text, names: namesForImportClause(statement.importClause), lazy: false });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      entries.push({ source: statement.moduleSpecifier.text, names: namesForExportClause(statement.exportClause), lazy: false });
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) entries.push({ source: argument.text, names: [], lazy: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
}

function collectImports(path, text) {
  const { diagnostics, outputText, sourceFile } = transpileSource(path, text);
  const sourceResult = sourceImportEntries(sourceFile);
  const sourceEntries = sourceResult.entries;
  const runtimeEntries = outputRuntimeEntries(path, outputText);
  const imports = [];
  for (const entry of sourceEntries) {
    const outputEntries = runtimeEntries.filter((candidate) => candidate.source === entry.source && candidate.lazy === entry.lazy);
    const outputNames = new Set(outputEntries.flatMap((candidate) => candidate.names));
    const hasRuntime = entry.forceRuntime || outputEntries.length > 0;
    const hasType = entry.explicitType || (!entry.sideEffect && entry.names.length > 0 && (!hasRuntime || entry.names.some((name) => !outputNames.has(name))));
    const kinds = [...(hasType ? ['type'] : []), ...(hasRuntime ? ['runtime'] : [])];
    if (kinds.length > 0) addImport(imports, entry.source, kinds, entry.line, entry.lazy);
  }
  // The automatic JSX runtime adds a package import absent from source syntax.
  for (const entry of runtimeEntries) {
    if (!sourceEntries.some((source) => source.source === entry.source && source.lazy === entry.lazy)) {
      addImport(imports, entry.source, ['runtime'], undefined, entry.lazy);
    }
  }
  return { diagnostics: [...diagnostics, ...sourceResult.unsupported], imports };
}

function configuredAliases(reader) {
  // Read only an explicit exported configuration. Never execute Vite plugins.
  const config = ts.createSourceFile('vite.config.ts', reader.read('vite.config.ts'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exported = config.statements.find(ts.isExportAssignment);
  let root = exported?.expression;
  if (root && ts.isCallExpression(root) && ts.isIdentifier(root.expression) && root.expression.text === 'defineConfig' && root.arguments.length === 1) {
    root = root.arguments[0];
    if (ts.isArrowFunction(root) || ts.isFunctionExpression(root)) {
      const body = root.body;
      if (ts.isBlock(body)) {
        const returns = [];
        const visit = (node) => {
          if (node !== body && ts.isFunctionLike(node)) return;
          if (ts.isReturnStatement(node)) returns.push(node.expression);
          ts.forEachChild(node, visit);
        };
        visit(body);
        root = returns.length === 1 ? returns[0] : undefined;
      } else root = body;
    }
  }
  if (config.parseDiagnostics.length || !root || !ts.isObjectLiteralExpression(root)) {
    throw new Error('Import guard requires an explicit exported Vite configuration object. Update the resolver when changing its format.');
  }
  const propertyName = (node) => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
  const objectProperty = (object, name) => {
    // Spreads/computed keys could replace resolve or alias after this property.
    if (object.properties.some((entry) => ts.isSpreadAssignment(entry) || (entry.name && ts.isComputedPropertyName(entry.name)))) {
      throw new Error('Import guard cannot analyze spreads or computed keys in Vite resolution configuration.');
    }
    const matches = object.properties.filter((entry) => entry.name && propertyName(entry.name) === name);
    if (matches.length !== 1 || !ts.isPropertyAssignment(matches[0]) || !ts.isObjectLiteralExpression(matches[0].initializer)) {
      throw new Error(`Import guard requires a literal Vite ${name} object. Update the resolver when changing its format.`);
    }
    return matches[0].initializer;
  };
  if (root.properties.some((entry) => entry.name && propertyName(entry.name) === 'root')) {
    throw new Error('Import guard requires the default Vite project root.');
  }
  const resolution = objectProperty(root, 'resolve');
  if (resolution.properties.some((entry) => entry.name && !['alias', 'dedupe'].includes(propertyName(entry.name)))) {
    throw new Error('Import guard requires support for additional Vite resolution options before they can be used.');
  }
  const aliasObject = objectProperty(resolution, 'alias');
  const aliases = new Map();
  for (const entry of aliasObject.properties) {
    if (!ts.isPropertyAssignment(entry) || !propertyName(entry.name) || !ts.isStringLiteral(entry.initializer)) {
      throw new Error('Import guard requires literal Vite alias names and replacements.');
    }
    const name = propertyName(entry.name);
    if (aliases.has(name)) throw new Error(`Import guard cannot analyze duplicate Vite alias ${name}.`);
    const replacement = entry.initializer.text;
    // Keep the accepted contract portable and free of String.replace tokens.
    if (!/^[@a-zA-Z_][@a-zA-Z0-9_./-]*$/.test(name)
      || !/^(?:\/src(?:\/|$)|\.\.?\/)/.test(replacement)
      || /[\\$?#\0]/.test(replacement)) {
      throw new Error(`Import guard supports alias ${name} only with a /src root path or an importer-relative replacement; unsupported alias name or replacement.`);
    }
    aliases.set(name, replacement);
  }
  // Vite normalizeAlias preserves object key order and trims only paired slashes.
  return [...aliases].map(([name, replacement]) => name.endsWith('/') && replacement.endsWith('/')
    ? [name.slice(0, -1), replacement.slice(0, -1)]
    : [name, replacement]);
}

function localModulePath(from, specifier, aliases) {
  if (specifier.startsWith('#')) throw new Error(`Import guard does not support package imports mappings: ${specifier}`);
  let modulePath = specifier;
  for (const [name, replacement] of aliases) {
    if (modulePath === name || modulePath.startsWith(`${name}/`)) {
      modulePath = replacement + modulePath.slice(name.length);
      break;
    }
  }
  modulePath = modulePath.split(/[?#]/, 1)[0];
  // Vite root paths and TypeScript's baseUrl: "." resolve to the same sources.
  if (modulePath === '/src' || modulePath.startsWith('/src/')) modulePath = modulePath.slice(1);
  const relativeImport = /^\.\.?(?:\/|$)/.test(modulePath);
  if (!relativeImport && modulePath !== 'src' && !modulePath.startsWith('src/')) {
    if (/^(?:\/|file:|[a-zA-Z]:[\\/])/.test(modulePath) && isTargetedModuleSpecifier(modulePath)) {
      throw new Error(`Import guard supports local module paths only within /src or relative to the importer: ${specifier}`);
    }
    return undefined;
  }
  return normalizePath(normalize(relativeImport ? join(dirname(from), modulePath) : modulePath));
}

// Vite's default extension order, checked differentially against the installed resolver.
const VITE_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

function resolveLocalImport(from, specifier, available, aliases) {
  const base = localModulePath(from, specifier, aliases);
  if (base === undefined) return undefined;
  if (base !== 'src' && !base.startsWith('src/')) throw new Error(`Import guard cannot resolve a source import outside src/: ${specifier}`);
  const candidates = [base];
  // Exact files precede JS-output remapping; appended extensions keep the original suffix.
  if (/\.(?:js|mjs|cjs|jsx)$/.test(base)) {
    candidates.push(base.replace(/js(x?)$/, 'ts$1'));
    if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.tsx');
  }
  candidates.push(...VITE_EXTENSIONS.map((extension) => base + extension));
  for (const candidate of candidates) {
    if (available.has(candidate)) return candidate;
  }
  if (available.has(`${base}/package.json`)) {
    throw new Error(`Import guard requires explicit file imports for source directories with package.json: ${specifier}`);
  }
  return VITE_EXTENSIONS.map((extension) => `${base}/index${extension}`).find((candidate) => available.has(candidate));
}

function isTargetedModuleSpecifier(specifier) {
  const extension = extname(specifier.split(/[?#]/, 1)[0]).toLowerCase();
  return !extension || ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(extension);
}

function edgeKey(from, to, kind) {
  return `${from}|${to}|${kind}`;
}

function pairKey(from, to) {
  return `${from}|${to}`;
}

function collectGraph(reader) {
  // Package self-references and browser maps can redirect apparently external imports.
  for (const path of ['package.json', ...reader.resolutionFiles.filter((file) => file.endsWith('/package.json'))]) {
    const manifest = JSON.parse(reader.read(path));
    if (manifest.exports !== undefined || manifest.browser !== undefined) {
      throw new Error(`Import guard requires support for package exports/browser resolution before using ${path}.`);
    }
  }
  const available = new Set(reader.resolutionFiles);
  const aliases = configuredAliases(reader);
  const edges = new Map();
  const diagnostics = [];
  const unresolved = [];
  const externalImports = [];
  for (const from of reader.files) {
    const result = collectImports(from, reader.read(from));
    diagnostics.push(...result.diagnostics.map((message) => ({ file: from, message })));
    for (const importEntry of result.imports) {
      let to;
      try {
        to = resolveLocalImport(from, importEntry.source, available, aliases);
        if (to && !isSourceFile(to)) {
          if (!EXCLUDED_SUFFIXES.some((suffix) => to.endsWith(suffix)) && isTargetedModuleSpecifier(to)) throw new Error(`Import guard resolved an unsupported source module: ${to}`);
          continue;
        }
      } catch (error) {
        diagnostics.push({ file: from, message: error.message });
        continue;
      }
      if (!to) {
        if (localModulePath(from, importEntry.source, aliases) !== undefined) {
          if (isTargetedModuleSpecifier(importEntry.source)) unresolved.push({ from, specifier: importEntry.source, line: importEntry.line });
        } else {
          externalImports.push({ from, specifier: importEntry.source, kinds: importEntry.kinds, line: importEntry.line });
        }
        continue;
      }
      const key = pairKey(from, to);
      const edge = edges.get(key) ?? { from, to, kinds: new Set(), lines: [], hasEagerRuntime: false, hasLazyRuntime: false };
      for (const kind of importEntry.kinds) edge.kinds.add(kind);
      if (importEntry.kinds.includes('runtime')) {
        if (importEntry.lazy) edge.hasLazyRuntime = true;
        else edge.hasEagerRuntime = true;
      }
      edge.lines.push({ line: importEntry.line, kinds: importEntry.kinds, lazy: importEntry.lazy });
      edges.set(key, edge);
    }
  }
  const serializedEdges = [...edges.values()].map((edge) => ({
    from: edge.from,
    to: edge.to,
    kinds: sorted(edge.kinds),
    lazy: edge.hasLazyRuntime && !edge.hasEagerRuntime,
    hasEagerRuntime: edge.hasEagerRuntime,
    hasLazyRuntime: edge.hasLazyRuntime,
    lines: edge.lines.sort((left, right) => left.line - right.line),
  })).sort((left, right) => `${left.from}|${left.to}`.localeCompare(`${right.from}|${right.to}`));
  return { edges: serializedEdges, externalImports, diagnostics, unresolved };
}

function edgeHasKind(edge, kind) {
  return edge.kinds.includes(kind);
}

function matchesPrefix(path, prefixes) {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function ruleViolations(edges) {
  const violations = [];
  for (const edge of edges) {
    for (const rule of RULES) {
      if (!matchesPrefix(edge.from, rule.sourcePrefixes) || !matchesPrefix(edge.to, rule.targetPrefixes)) continue;
      const kinds = rule.kinds.filter((kind) => edgeHasKind(edge, kind));
      for (const kind of kinds) {
        violations.push({ rule: rule.id, label: rule.label, kind, from: edge.from, to: edge.to });
      }
    }
  }
  return violations.sort(compareViolation);
}

function compareViolation(left, right) {
  return [left.rule, left.kind, left.from, left.to].join('|').localeCompare([right.rule, right.kind, right.from, right.to].join('|'));
}

function adjacencyFor(edges, kind, eagerOnly = false) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!edgeHasKind(edge, kind)) continue;
    if (eagerOnly && !edge.hasEagerRuntime) continue;
    const children = adjacency.get(edge.from) ?? new Set();
    children.add(edge.to);
    adjacency.set(edge.from, children);
  }
  return adjacency;
}

function stronglyConnectedComponents(files, edges, eagerOnly = false) {
  const adjacency = adjacencyFor(edges, 'runtime', eagerOnly);
  const nodes = new Set(files);
  for (const edge of edges) {
    if (edgeHasKind(edge, 'runtime') && (!eagerOnly || edge.hasEagerRuntime)) {
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
  }
  let index = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (node) => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const child of sorted(adjacency.get(node) ?? [])) {
      if (!indices.has(child)) {
        visit(child);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(child)));
      } else if (onStack.has(child)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(child)));
      }
    }
    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      let child;
      do {
        child = stack.pop();
        onStack.delete(child);
        component.push(child);
      } while (child !== node);
      const sortedComponent = sorted(component);
      const hasSelfLoop = sortedComponent.length === 1 && (adjacency.get(sortedComponent[0]) ?? new Set()).has(sortedComponent[0]);
      if (sortedComponent.length > 1 || hasSelfLoop) components.push(sortedComponent);
    }
  };
  for (const node of sorted(nodes)) if (!indices.has(node)) visit(node);
  return components.sort((left, right) => left.join('|').localeCompare(right.join('|')));
}

function componentKey(component) {
  return component.join('|');
}

function componentIsAllowedByBaseline(component, baselineComponents, baselineEdges) {
  const currentNodes = new Set(component);
  for (const baselineComponent of baselineComponents) {
    const baselineNodes = new Set(baselineComponent);
    if (![...currentNodes].every((node) => baselineNodes.has(node))) continue;
    if (currentNodes.size === baselineNodes.size) return true;
    const inducedBaselineSccs = stronglyConnectedComponents(component, baselineEdges.filter((edge) =>
      edgeHasKind(edge, 'runtime') && currentNodes.has(edge.from) && currentNodes.has(edge.to)));
    if (inducedBaselineSccs.some((candidate) => componentKey(candidate) === componentKey(component))) return true;
  }
  return false;
}

function exactForbiddenEdges(edges) {
  return EXPLICITLY_FORBIDDEN_EDGES.flatMap((forbidden) => {
    const edge = edges.find((candidate) => candidate.from === forbidden.from && candidate.to === forbidden.to);
    return edge ? [{ ...forbidden, kinds: edge.kinds }] : [];
  });
}

function ownerForViolation(violation) {
  const source = violation.from.toLowerCase();
  if (source.includes('/provider') || source.includes('/providers/')) return 'Providers';
  if (source.includes('streamingchat') || source.includes('chat') || source.includes('conversation')) return 'Chat';
  if (source.includes('architect') || source.includes('plan') || source.includes('task') || source.includes('implement') || source.includes('merge') || source.includes('worktree')) return 'Tasks/Plans';
  return 'Shell';
}

function exceptionKey(exception) {
  return `${exception.rule}|${exception.kind}|${exception.from}|${exception.to}`;
}

function exceptionsForReport(violations) {
  return violations
    .filter((violation) => !EXPLICITLY_FORBIDDEN_EDGES.some((forbidden) => forbidden.from === violation.from && forbidden.to === violation.to))
    .map((violation) => ({
      ...violation,
      owner: ownerForViolation(violation),
      reason: `Existing dependency assigned to the ${ownerForViolation(violation)} lot.`,
    }))
    .sort(compareViolation);
}

export function analyzeReader(reader, sourceRef = 'worktree') {
  const graph = collectGraph(reader);
  const sccs = stronglyConnectedComponents(reader.files, graph.edges);
  const eagerSccs = stronglyConnectedComponents(reader.files, graph.edges, true);
  const dynamicSccs = sccs.filter((component) => graph.edges.some((edge) =>
    edge.hasLazyRuntime && component.includes(edge.from) && component.includes(edge.to)));
  const violations = ruleViolations(graph.edges);
  const explicitForbiddenEdges = exactForbiddenEdges(graph.edges);
  const edgeCounts = graph.edges.reduce((counts, edge) => {
    for (const kind of edge.kinds) counts[kind] += 1;
    return counts;
  }, { runtime: 0, type: 0 });
  return {
    schemaVersion: 1,
    sourceRef,
    fileCount: reader.files.length,
    edgeCount: graph.edges.length,
    runtimeEdgeCount: edgeCounts.runtime,
    typeEdgeCount: edgeCounts.type,
    edges: graph.edges,
    sccs,
    eagerSccs,
    dynamicSccs,
    sccCount: sccs.length,
    eagerSccCount: eagerSccs.length,
    dynamicSccCount: dynamicSccs.length,
    violations,
    explicitForbiddenEdges,
    extractedBoundaries: {
      chat: chatBoundaryViolations(graph.edges, graph.externalImports),
      native: nativeBoundaryViolations(reader),
      nativeFiles: reader.nativeFiles ?? [],
    },
    exceptions: exceptionsForReport(violations),
    diagnostics: graph.diagnostics.sort((left, right) => `${left.file}|${left.message}`.localeCompare(`${right.file}|${right.message}`)),
    unresolved: graph.unresolved.sort((left, right) => `${left.from}|${left.specifier}|${left.line}`.localeCompare(`${right.from}|${right.specifier}|${right.line}`)),
  };
}

export function analyzeSources(sources, sourceRef = 'virtual') {
  return analyzeReader(createVirtualReader(sources), sourceRef);
}

function baselineFromReport(report, baseRef) {
  const sccNodes = new Set(report.sccs.flat());
  const eagerSccNodes = new Set(report.eagerSccs.flat());
  const compactEdge = (edge) => ({ from: edge.from, to: edge.to, kinds: edge.kinds, lazy: edge.lazy, hasEagerRuntime: edge.hasEagerRuntime, hasLazyRuntime: edge.hasLazyRuntime });
  return {
    schemaVersion: report.schemaVersion,
    policy: {
      rules: RULES.map(({ id, label, kinds, sourcePrefixes, targetPrefixes }) => ({ id, label, kinds, sourcePrefixes, targetPrefixes })),
      explicitlyForbiddenEdges: EXPLICITLY_FORBIDDEN_EDGES,
      sccRatchet: {
        allowStrictSubset: true,
        requireBaselineInducedCycle: true,
      },
    },
    baseRef,
    sourceMode: 'git-show',
    fileCount: report.fileCount,
    edgeCount: report.edgeCount,
    runtimeEdgeCount: report.runtimeEdgeCount,
    typeEdgeCount: report.typeEdgeCount,
    runtimeSccEdges: report.edges.filter((edge) => edgeHasKind(edge, 'runtime') && sccNodes.has(edge.from) && sccNodes.has(edge.to)).map(compactEdge),
    eagerSccEdges: report.edges.filter((edge) => edgeHasKind(edge, 'runtime') && eagerSccNodes.has(edge.from) && eagerSccNodes.has(edge.to) && edge.hasEagerRuntime).map(compactEdge),
    sccs: report.sccs,
    eagerSccs: report.eagerSccs,
    dynamicSccs: report.dynamicSccs,
    exceptions: report.exceptions,
  };
}

function baselineExceptionSet(baseline) {
  return new Set((baseline.exceptions ?? []).map(exceptionKey));
}

export function compareReports(baseline, current) {
  const allowedExisting = baselineExceptionSet(baseline);
  const newForbiddenEdges = current.violations.filter((violation) => !allowedExisting.has(exceptionKey(violation)));
  const baselineRuntimeSccEdges = baseline.runtimeSccEdges ?? baseline.edges ?? [];
  const baselineEagerSccEdges = baseline.eagerSccEdges ?? baselineRuntimeSccEdges;
  const newSccs = current.sccs.filter((component) => !componentIsAllowedByBaseline(component, baseline.sccs ?? [], baselineRuntimeSccEdges));
  const newEagerSccs = current.eagerSccs.filter((component) => !componentIsAllowedByBaseline(component, baseline.eagerSccs ?? baseline.sccs ?? [], baselineEagerSccEdges));
  const currentExceptionKeys = new Set(current.exceptions.map(exceptionKey));
  const resolvedExceptions = (baseline.exceptions ?? []).filter((exception) => !currentExceptionKeys.has(exceptionKey(exception)));
  const explicitForbiddenEdges = current.explicitForbiddenEdges;
  const newModelRuntimeEdges = newForbiddenEdges.filter((violation) => violation.rule === 'models-to-application' && violation.kind === 'runtime');
  const extractedBoundaryViolations = [
    ...(current.extractedBoundaries?.chat ?? []),
    ...(current.extractedBoundaries?.native ?? []),
  ];
  return {
    baseRef: baseline.baseRef,
    newForbiddenEdges,
    newModelRuntimeEdges,
    newSccs,
    newEagerSccs,
    explicitForbiddenEdges,
    resolvedExceptions,
    extractedBoundaryViolations,
    passed: newForbiddenEdges.length === 0 && newSccs.length === 0 && newEagerSccs.length === 0 && explicitForbiddenEdges.length === 0 && extractedBoundaryViolations.length === 0 && current.diagnostics.length === 0 && current.unresolved.length === 0,
  };
}

export function buildReport(current, comparison) {
  return {
    ...current,
    comparison,
    measures: {
      files: current.fileCount,
      localEdges: current.edgeCount,
      runtimeEdges: current.runtimeEdgeCount,
      typeEdges: current.typeEdgeCount,
      nonTrivialSccs: current.sccCount,
      eagerSccs: current.eagerSccCount,
      dynamicSccs: current.dynamicSccCount,
      forbiddenEdges: current.violations.length,
      explicitForbiddenEdges: current.explicitForbiddenEdges.length,
      unresolvedLocalModules: current.unresolved.length,
      syntaxDiagnostics: current.diagnostics.length,
    },
  };
}

function parseArguments(argv) {
  const options = { check: false, format: 'text', root: process.cwd(), baseline: BASELINE_PATH, report: undefined, base: undefined, writeBaseline: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--format') options.format = argv[++index];
    else if (argument === '--root') options.root = resolve(argv[++index]);
    else if (argument === '--baseline') options.baseline = argv[++index];
    else if (argument === '--report') options.report = argv[++index];
    else if (argument === '--base') options.base = argv[++index];
    else if (argument === '--write-baseline') options.writeBaseline = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!['json', 'text'].includes(options.format)) throw new Error(`Unsupported format: ${options.format}`);
  return options;
}

function usage() {
  return [
    'Usage: bun dev/architecture/import-boundaries.mjs [options]',
    '',
    '  --check                         Check the worktree against the portable baseline.',
    '  --base <git-ref>                Analyze a git ref with read-only git show calls.',
    '  --write-baseline <path>         Write a deterministic baseline from --base.',
    '  --baseline <path>               Baseline JSON used by --check.',
    '  --report <path>                 Write the current JSON report.',
    '  --format <text|json>            Select stdout format.',
    '  --root <path>                   Repository root. Defaults to cwd.',
  ].join('\n');
}

function formatText(report) {
  const lines = [
    `Import boundary report for ${report.sourceRef}`,
    `Files: ${report.fileCount}`,
    `Local edges: ${report.edgeCount} (${report.runtimeEdgeCount} runtime, ${report.typeEdgeCount} type)`,
    `Non-trivial runtime SCCs: ${report.sccCount}`,
    `Eager SCCs: ${report.eagerSccCount} (${report.dynamicSccCount} global SCCs contain a lazy import)`,
    `Forbidden edges: ${report.violations.length} (${report.exceptions.length} baseline exceptions, ${report.explicitForbiddenEdges.length} explicitly forbidden)`,
    `Unresolved targeted modules: ${report.unresolved.length}`,
    `Transpile diagnostics: ${report.diagnostics.length}`,
    `Extracted Chat boundary violations: ${report.extractedBoundaries.chat.length}`,
    `Extracted native boundary violations: ${report.extractedBoundaries.native.length} (${report.extractedBoundaries.nativeFiles.length} files)`,
  ];
  if (report.comparison) {
    lines.push(`New forbidden edges: ${report.comparison.newForbiddenEdges.length}`);
    lines.push(`New model runtime edges: ${report.comparison.newModelRuntimeEdges.length}`);
    lines.push(`New SCCs: ${report.comparison.newSccs.length}`);
    lines.push(`New eager SCCs: ${report.comparison.newEagerSccs.length}`);
    lines.push(`Check: ${report.comparison.passed ? 'PASS' : 'FAIL'}`);
  }
  const printViolations = (title, violations) => {
    if (violations.length === 0) return;
    lines.push(`${title}:`);
    for (const violation of violations) lines.push(`  ${violation.from} -> ${violation.to} [${violation.kind ?? 'runtime'}]`);
  };
  if (report.comparison) printViolations('New forbidden edges', report.comparison.newForbiddenEdges);
  printViolations('Explicitly forbidden edges', report.explicitForbiddenEdges);
  for (const violation of [...report.extractedBoundaries.chat, ...report.extractedBoundaries.native]) {
    lines.push(`  ${violation.from}${violation.line ? `:${violation.line}` : ''} -> ${violation.to} [${violation.rule}]${violation.path ? ` via ${violation.path.join(' -> ')}` : ''}`);
  }
  if (report.unresolved.length > 0) {
    lines.push('Unresolved targeted modules:');
    for (const unresolved of report.unresolved) lines.push(`  ${unresolved.from}:${unresolved.line} -> ${unresolved.specifier}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push('Transpile diagnostics:');
    for (const diagnostic of report.diagnostics) lines.push(`  ${diagnostic.file}: ${diagnostic.message}`);
  }
  if (report.comparison?.newSccs.length) {
    lines.push('New SCCs:');
    for (const scc of report.comparison.newSccs) lines.push(`  ${scc.join(' -> ')}`);
  }
  if (report.comparison?.newEagerSccs.length) {
    lines.push('New eager SCCs:');
    for (const scc of report.comparison.newEagerSccs) lines.push(`  ${scc.join(' -> ')}`);
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const root = resolve(options.root);
  const current = analyzeReader(options.base ? createGitReader(root, options.base) : createFilesystemReader(root), options.base ?? 'worktree');
  if (options.writeBaseline) {
    if (!options.base) throw new Error('--write-baseline requires --base <git-ref>.');
    writeFileSync(resolve(root, options.writeBaseline), `${JSON.stringify(baselineFromReport(current, options.base), null, 2)}\n`);
  }
  let report = current;
  if (options.check) {
    const baselinePath = resolve(root, options.baseline);
    if (!existsSync(baselinePath)) throw new Error(`Baseline not found: ${baselinePath}`);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    report = buildReport(current, compareReports(baseline, current));
  }
  if (options.report) writeFileSync(resolve(root, options.report), `${JSON.stringify(report, null, 2)}\n`);
  console.log(options.format === 'json' ? JSON.stringify(report, null, 2) : formatText(report));
  return options.check && !report.comparison.passed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
