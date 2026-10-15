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
  const badge = document.createElement('div');
  badge.id = 'macro-demo-controls';
  badge.setAttribute('role', 'region');
  badge.setAttribute('aria-label', 'Mode démo');
  badge.style.cssText = 'position:fixed;bottom:28px;right:12px;z-index:99999;display:flex;align-items:center;gap:10px;background:#18181b;border:1px solid #6366f1;border-radius:8px;padding:7px 10px;color:#e4e4e7;font:12px system-ui;box-shadow:0 4px 18px #0006';
  const label = document.createElement('span');
  label.textContent = 'Démo · Données fictives';
  badge.append(label);
  const reset = document.createElement('button');
  reset.textContent = 'Réinitialiser';
  reset.style.cssText = 'border:0;background:#34343d;color:inherit;border-radius:4px;padding:4px 7px;cursor:pointer';
  reset.onclick = () => location.reload();
  badge.append(reset);
  document.body.append(badge);
  // Only demo diagnostics, never real application data.
  Object.defineProperty(window, '__MACRO_DEMO__', { value: runtime, configurable: true });
  document.title = 'Macro · Démo';
}
