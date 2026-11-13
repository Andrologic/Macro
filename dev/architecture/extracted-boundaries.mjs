// These policies protect the delivered extractions, independently of the historical baseline.
export const CHAT_RUNTIME_ENTRIES = Object.freeze([
  'src/services/chatTurnRuntime.ts',
  'src/services/chatRequestPreparation.ts',
  'src/services/chatAssistantStreamRuntime.ts',
  'src/services/chatToolExecution.ts',
  'src/services/chatToolExecutionRuntime.ts',
  'src/services/chatAssistantPersistenceRuntime.ts',
  'src/services/chatCompactionRuntime.ts',
  'src/services/chatStreamOrchestrator.ts',
  'src/services/chatSend/sendMessage.ts',
]);

const isUiPackage = (specifier) => /^(react|react-dom|zustand)(\/|$)/.test(specifier);
const isNativePackage = (specifier) => specifier.startsWith('@tauri-apps/');
// Concrete generation, cancellation, diagnostics and fallback-tool I/O only.
// Contracts, codecs and orchestration in the same directory remain available.
const AI_ADAPTERS = new Set([
  'src/services/ai/chatCompletionsAdapter.ts',
  'src/services/ai/nativeAdapter.ts',
  'src/services/ai/nativeTurnTransport.ts',
  'src/services/ai/httpTransport.ts',
  'src/services/ai/streamResources.ts',
  'src/services/ai/streamDiagnostics.ts',
  'src/services/ai/fallbackTools.ts',
]);
const isConcreteAdapter = (path) =>
  AI_ADAPTERS.has(path) ||
  path === 'src/services/tauriIpc.ts' ||
  path === 'src/services/tauriRuntimeBridge.ts' ||
  path === 'src/services/tauriHttp.ts' ||
  path === 'src/services/browserRuntimeTransport.ts' ||
  path === 'src/services/tauriDialog.ts' ||
  path === 'src/services/tauriWindow.ts' ||
  (path.startsWith('src/services/ipc/') && !path.endsWith('.types.ts')) ||
  path === 'src/services/streamingChat.ts' ||
  path === 'src/services/streamingChatExecution.ts' ||
  path.startsWith('src/services/providers/') ||
  path.startsWith('src/composition/');

export function chatBoundaryViolations(edges, externalImports) {
  const runtimeEdges = edges.filter((edge) => edge.kinds.includes('runtime'));
  const runtimeImports = externalImports.filter((entry) => entry.kinds.includes('runtime'));
  const violations = [];
  for (const entry of CHAT_RUNTIME_ENTRIES) {
    const paths = new Map([[entry, [entry]]]);
    // Traverse both eager and lazy runtime edges; type dependencies never load a module.
    for (const [from, path] of paths) {
      for (const edge of runtimeEdges.filter((candidate) => candidate.from === from)) {
        if (!paths.has(edge.to)) paths.set(edge.to, [...path, edge.to]);
        if (from === entry && isConcreteAdapter(edge.to)) {
          violations.push({ rule: 'chat-entry-to-adapter', entry, from, to: edge.to, path: [...path, edge.to] });
        }
      }
      for (const imported of runtimeImports.filter((candidate) => candidate.from === from)) {
        if (isUiPackage(imported.specifier) || (from === entry && isNativePackage(imported.specifier))) {
          violations.push({
            rule: isUiPackage(imported.specifier) ? 'chat-runtime-to-ui-package' : 'chat-entry-to-adapter',
            entry, from, to: imported.specifier, line: imported.line, path: [...path, imported.specifier],
          });
        }
      }
    }
  }
  return violations;
}

const NATIVE_FILES = new Set([
  'src-tauri/src/core/command_error.rs',
  'src-tauri/src/core/db_state.rs',
  'src-tauri/src/core/mcp_ids.rs',
  'src-tauri/src/fs/operations.rs',
  'src-tauri/src/fs/mutation_locks.rs',
  'src-tauri/src/git/operations.rs',
]);

export function isExtractedNativeFile(path) {
  return path.endsWith('.rs') && (NATIVE_FILES.has(path) ||
    path.startsWith('src-tauri/src/core/workspace_execution/') ||
    path.startsWith('src-tauri/src/git/operations/'));
}

export function nativeBoundaryViolations(reader) {
  // Deliberately a bounded textual guard, not a Rust resolver. Reserving these
  // identifiers also catches grouped imports, renames and qualified expressions.
  // Comments/string literals are included; see README.md for the tradeoff.
  return (reader.nativeFiles ?? []).flatMap((from) => {
    const source = reader.read(from);
    return [...source.matchAll(/\b(?:commands|tauri|AppHandle|State|Window)\b/g)].map((match) => ({
      rule: 'native-core-adapter-identifier', from, to: match[0],
      line: source.slice(0, match.index).split('\n').length,
    }));
  });
}

// The future engine and mixed files identified by the D15 destination map.
const MACRO_ONLY = new Set(['agsdl_host_capture.rs', 'agsdl_host_catalogue.rs', 'agsdl_host_tasks.rs', 'agsdl_host_tools.rs', 'agsdl_intent_coordinator.rs']);
const ENGINE_SHARED = new Set([
  'ai/stream_tasks.rs', 'core/process.rs', 'core/tool_policy.rs', 'commands/mcp/agsdl_raw.rs',
  'commands/mcp/agsdl_raw_tests.rs', 'db/exact_json.rs', 'fs/operations.rs',
]);
const ENGINE_DB = /^(?:call_protocol030|discovery030|dto|flow_store030|flow_work_protocol030|json_lexemes030|mod|public030|start030|work_dto030)(?:_tests)?\.rs$/;
export function isArgenticFile(path) {
  if (!path.endsWith('.rs')) return false;
  if (/^crates\/argentic-(?:core|runtime)\//.test(path)) return true;
  if (!path.startsWith('src-tauri/src/')) return false;
  const name = path.slice('src-tauri/src/'.length);
  if (name === 'agsdl_permissions/ipc.rs') return false; // Application wire mirrors only.
  if (/^argentic_(?:core|runtime)\//.test(name)) return true;
  if (ENGINE_SHARED.has(name)) return true;
  if (/^(?:agsdl_content|agsdl_permissions|agsdl_host_confinement|agsdl_host_codex|agsdl_host_codex030|agsdl_host_claude)\//.test(name)) return true;
  if (/^agsdl_host(?:_|\.rs)/.test(name) && !name.includes('/') && !MACRO_ONLY.has(name)) return true;
  if (name.startsWith('db/agsdl_execution/v030/')) return true;
  if (name.startsWith('db/agsdl_execution/')) return ENGINE_DB.test(name.slice('db/agsdl_execution/'.length));
  return false;
}

const APPLICATION_ROOTS = ['db', 'commands', 'config', 'git', 'workspace', 'ai', 'secrets', 'project_path', 'fs', 'core'];
const TOKENS = ['tauri', 'AppHandle', 'ts_rs', 'sqlx', 'rusqlite'];
const PURE_ROOT = /^(?:src-tauri\/src\/argentic_core\/|crates\/argentic-core\/)/;

export function argenticRustCounts(reader) {
  const result = {};
  for (const file of reader.argenticFiles ?? []) {
    const source = reader.read(file);
    const counts = {};
    const add = (rule) => { counts[rule] = (counts[rule] ?? 0) + 1; };
    for (const token of TOKENS) {
      if (token === 'sqlx' && file.startsWith('crates/argentic-runtime/')) continue;
      for (const unused of source.matchAll(new RegExp(`\\b${token}\\b`, 'g'))) add(`token:${token}`);
    }
    for (const match of source.matchAll(/\bcrate\s*::\s*(db|commands|config|git|workspace|ai|secrets|project_path|fs|core)\b/g)) add(`crate:${match[1]}`);
    // Reserve root identifiers within a grouped crate import. Braces are
    // balanced textually, without interpreting Rust macros, comments or strings.
    for (const group of source.matchAll(/\bcrate\s*::\s*\{/g)) {
      let depth = 1;
      let end = group.index + group[0].length;
      const start = end;
      while (end < source.length && depth) {
        if (source[end] === '{') depth += 1;
        if (source[end] === '}') depth -= 1;
        end += 1;
      }
      for (const match of source.slice(start, depth ? source.length : end - 1).matchAll(/\b(db|commands|config|git|workspace|ai|secrets|project_path|fs|core)\b/g)) add(`crate:${match[1]}`);
    }
    if (PURE_ROOT.test(file)) {
      for (const match of source.matchAll(/\b(f64|as_f64)\b/g)) add(`pure:${match[1]}`);
    }
    if (Object.keys(counts).length) result[file] = Object.fromEntries(Object.entries(counts).sort());
  }
  return Object.fromEntries(Object.entries(result).sort());
}

// Direct importers of the evaluation modules, both type and runtime edges.
const EVALUATION_MODULES = new Set([
  ...['compiler030', 'compilerGraph030', 'configuration030', 'hostCompilation', 'metadata', 'agentWorkContracts030', 'exact', 'workIntegers030', 'valueSchemaPort030', 'agentWorkController030', 'agentSubmission030', 'hostWorkJournal030', 'hostWorkTransition030', 'invariants', 'routes030', 'prepareFlowRoute030', 'messages030', 'calls030', 'contentResolution030', 'hostHumanClock030', 'workClock030', 'hostWorkPort030', 'hostWorkPump030', 'hostRouteBroker030'].map((name) => `src/services/agsdlExecution/${name}.ts`),
  ...['validator', 'graph', 'schemacheck', 'permissions', 'reader', 'json', 'values'].map((name) => `src/vendor/agsdl/v0.3/${name}.mjs`),
  'src/vendor/agsdl/v0.3/valueschema.mjs', 'src/vendor/agsdl/shared/json.mjs', 'src/vendor/agsdl/shared/values.mjs', 'src/vendor/agsdl/experimental/readers/javascript/json.mjs',
]);
export function argenticImportCounts(edges) {
  const counts = {};
  for (const edge of edges) {
    if (!EVALUATION_MODULES.has(edge.to)) continue;
    for (const kind of edge.kinds) {
      const rule = `import:${kind}:${edge.to}`;
      (counts[edge.from] ??= {})[rule] = 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort().map(([file, rules]) => [file, Object.fromEntries(Object.entries(rules).sort())]));
}

export function argenticCounts(reader, edges) {
  return { rust: argenticRustCounts(reader), imports: argenticImportCounts(edges) };
}

export function validateArgenticBaseline(baseline) {
  if (!baseline || baseline.schemaVersion !== 1 || baseline.baseRef !== '627ea641d8ab1439ca41e9cd68bb07454ea33c49' || !baseline.counts || Object.keys(baseline.counts).sort().join(',') !== 'imports,rust') throw new Error('Invalid Argentic baseline: expected schema, baseRef and counts.');
  for (const [category, files] of Object.entries(baseline.counts)) {
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error(`Invalid Argentic baseline: ${category} must be an object.`);
    for (const [file, rules] of Object.entries(files)) {
      if (!file || file.startsWith('/') || file.split('/').includes('..') || !rules || typeof rules !== 'object' || Array.isArray(rules) || !Object.keys(rules).length) throw new Error(`Invalid Argentic baseline entry: ${file}`);
      for (const [rule, count] of Object.entries(rules)) {
        const valid = category === 'rust' ? (TOKENS.some((token) => rule === `token:${token}`) || APPLICATION_ROOTS.some((root) => rule === `crate:${root}`)) : /^import:(?:runtime|type):src\//.test(rule);
        if (!valid || !Number.isSafeInteger(count) || count <= 0 || (category === 'rust' && !isArgenticFile(file)) || (category === 'imports' && count !== 1)) throw new Error(`Invalid Argentic baseline: ${file} [${rule}]`);
      }
    }
  }
}

export function compareArgentic(baseline, current) {
  validateArgenticBaseline(baseline);
  const issues = [];
  for (const category of ['rust', 'imports']) {
    const files = new Set([...Object.keys(baseline.counts[category]), ...Object.keys(current[category])]);
    for (const file of [...files].sort()) {
      const oldRules = baseline.counts[category][file] ?? {};
      const newRules = current[category][file] ?? {};
      for (const rule of [...new Set([...Object.keys(oldRules), ...Object.keys(newRules)])].sort()) {
        const limit = oldRules[rule] ?? 0;
        const count = newRules[rule] ?? 0;
        if (count !== limit) issues.push({ category, file, rule, count, limit, direction: count > limit ? 'increase' : 'decrease' });
      }
    }
  }
  return issues;
}

export function tightenArgentic(baseline, current) {
  validateArgenticBaseline(baseline);
  const counts = { rust: {}, imports: {} };
  for (const category of ['rust', 'imports']) {
    for (const [file, rules] of Object.entries(baseline.counts[category])) {
      for (const [rule, limit] of Object.entries(rules)) {
        const count = Math.min(limit, current[category][file]?.[rule] ?? 0);
        if (count) (counts[category][file] ??= {})[rule] = count;
      }
    }
  }
  return { ...baseline, counts };
}
