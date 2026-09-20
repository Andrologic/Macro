// These policies protect the delivered extractions, independently of the historical baseline.
export const CHAT_RUNTIME_ENTRIES = Object.freeze([
  'src/services/chatTurnRuntime.ts',
  'src/services/chatRequestPreparation.ts',
  'src/services/chatAssistantStreamRuntime.ts',
  'src/services/chatToolExecution.ts',
  'src/services/chatAssistantPersistenceRuntime.ts',
  'src/services/chatCompactionRuntime.ts',
  'src/services/chatStreamOrchestrator.ts',
  'src/services/chatSend/sendMessage.ts',
]);

const isUiPackage = (specifier) => /^(react|react-dom|zustand)(\/|$)/.test(specifier);
const isNativePackage = (specifier) => specifier.startsWith('@tauri-apps/');
const isConcreteAdapter = (path) =>
  path === 'src/services/tauriIpc.ts' ||
  path === 'src/services/tauriRuntimeBridge.ts' ||
  path === 'src/services/tauriHttp.ts' ||
  path === 'src/services/browserRuntimeTransport.ts' ||
  path === 'src/services/tauriDialog.ts' ||
  path === 'src/services/tauriWindow.ts' ||
  (path.startsWith('src/services/ipc/') && !path.endsWith('.types.ts')) ||
  path === 'src/services/streamingChat.ts' ||
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
