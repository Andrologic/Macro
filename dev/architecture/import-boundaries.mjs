#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

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

function sourceFileNames(rootDirectory) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(path);
      } else {
        const relativePath = normalizePath(relative(rootDirectory, path));
        if (isSourceFile(relativePath) && relativePath.startsWith('src/')) files.push(relativePath);
      }
    }
  };
  walk(rootDirectory);
  return sorted(files);
}

function gitSourceFileNames(rootDirectory, ref) {
  const output = execFileSync('git', ['-C', rootDirectory, 'ls-tree', '-r', '--name-only', ref, '--', 'src'], {
    encoding: 'utf8',
  });
  return sorted(output.split('\n').filter(isSourceFile));
}

function readGitFile(rootDirectory, ref, path) {
  return execFileSync('git', ['-C', rootDirectory, 'show', `${ref}:${path}`], { encoding: 'utf8' });
}

function createFilesystemReader(rootDirectory) {
  return {
    files: sourceFileNames(rootDirectory),
    read(path) {
      return readFileSync(join(rootDirectory, path), 'utf8');
    },
  };
}

function createGitReader(rootDirectory, ref) {
  return {
    files: gitSourceFileNames(rootDirectory, ref),
    read(path) {
      return readGitFile(rootDirectory, ref, path);
    },
  };
}

export function createVirtualReader(sources) {
  const normalizedSources = new Map(Object.entries(sources).map(([path, text]) => [normalizePath(path), text]));
  return {
    files: sorted([...normalizedSources.keys()].filter(isSourceFile)),
    read(path) {
      const text = normalizedSources.get(normalizePath(path));
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
  return { diagnostics: [...diagnostics, ...sourceResult.unsupported], imports };
}

function removeExtension(path) {
  return path.replace(/\.(?:tsx?|mts|cts)$/, '');
}

function isLocalModuleSpecifier(specifier) {
  // tsconfig.json uses baseUrl: "."; source-root imports are local too.
  return specifier.startsWith('.') || specifier.startsWith('src/');
}

function resolveLocalImport(from, specifier, available) {
  if (!isLocalModuleSpecifier(specifier)) return undefined;
  const modulePath = specifier.replace(/\.(?:m|c)?js$/, '');
  const base = normalizePath(normalize(specifier.startsWith('.')
    ? join(dirname(from), modulePath)
    : modulePath));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ].map(removeExtension);
  const availableWithoutExtensions = new Map([...available].map((file) => [removeExtension(file), file]));
  for (const candidate of candidates) {
    const resolved = availableWithoutExtensions.get(removeExtension(candidate));
    if (resolved) return resolved;
  }
  return undefined;
}

function isTargetedModuleSpecifier(specifier) {
  const extension = extname(specifier).toLowerCase();
  return !extension || ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(extension);
}

function edgeKey(from, to, kind) {
  return `${from}|${to}|${kind}`;
}

function pairKey(from, to) {
  return `${from}|${to}`;
}

function collectGraph(reader) {
  const available = new Set(reader.files);
  const edges = new Map();
  const diagnostics = [];
  const unresolved = [];
  for (const from of reader.files) {
    const result = collectImports(from, reader.read(from));
    diagnostics.push(...result.diagnostics.map((message) => ({ file: from, message })));
    for (const importEntry of result.imports) {
      const to = resolveLocalImport(from, importEntry.source, available);
      if (!to) {
        if (isLocalModuleSpecifier(importEntry.source) && isTargetedModuleSpecifier(importEntry.source)) unresolved.push({ from, specifier: importEntry.source, line: importEntry.line });
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
  return { edges: serializedEdges, diagnostics, unresolved };
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
  return {
    baseRef: baseline.baseRef,
    newForbiddenEdges,
    newModelRuntimeEdges,
    newSccs,
    newEagerSccs,
    explicitForbiddenEdges,
    resolvedExceptions,
    passed: newForbiddenEdges.length === 0 && newSccs.length === 0 && newEagerSccs.length === 0 && explicitForbiddenEdges.length === 0 && current.diagnostics.length === 0 && current.unresolved.length === 0,
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
