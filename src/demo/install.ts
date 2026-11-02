import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { createDemoRuntime } from './runtime';
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, clear: () => data.clear(), getItem: k => data.get(k) ?? null, key: i => [...data.keys()][i] ?? null, removeItem: k => { data.delete(k); }, setItem: (k, v) => { data.set(k, String(v)); } };
}
export async function installDemoRuntime(): Promise<void> {
  // A native window is deliberately rejected: its backend can already be running
  // before the JS entrypoint. A desktop demo needs its own native profile first.
  if ('__TAURI_INTERNALS__' in window)
    throw new Error('Launch the isolated browser demo with bun run dev:demo. Native profile isolation is required before a desktop demo can be enabled.');
  Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() });
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memoryStorage() });
  const fetchAssets = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin !== location.origin)
      return Promise.reject(new Error('Mode démo : les connexions externes sont désactivées.'));
    return fetchAssets(input, init);
  }) as typeof window.fetch;
  const runtime = createDemoRuntime((name, payload) => { void emit(name, payload); });
  mockIPC((command, args) => runtime.invoke(command, args as Record<string, unknown>), { shouldMockEvents: true });
  mockWindows('main');
  // Only demo diagnostics, never real application data.
  Object.defineProperty(window, '__MACRO_DEMO__', { value: runtime, configurable: true });
  document.title = 'Macro · Démo';
}
