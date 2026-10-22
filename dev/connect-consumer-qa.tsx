import React from 'react';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../src/i18n/locales/en.json';
import fr from '../src/i18n/locales/fr.json';
import { ConnectConsumerLauncher } from '../src/components/connect/ConnectConsumerLauncher';
import { PilotClientError } from '../src/services/macroPilot/clientError';
import { createConnectConsumerFixture } from './fixtures/connectConsumer';
import '../src/index.css';

if (!import.meta.env.DEV || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) throw new Error('Synthetic Connect QA requires DEV and loopback.');
await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, fr: { translation: fr } }, interpolation: { escapeValue: false }, showSupportNotice: false });
const fixture = createConnectConsumerFixture({ authorityLifetimeMs: 30000 });
let delayed = false, denied = false;
const releases = new Set<() => void>();
fixture.read(async (id, dispatch, signal) => {
  if (id === 'instance:alpha' && denied) throw new PilotClientError('forbidden');
  if (id === 'instance:alpha' && delayed) await new Promise<void>((resolve, reject) => {
    const release = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(new PilotClientError('context_changed')); };
    const cleanup = () => { releases.delete(release); signal.removeEventListener('abort', abort); };
    releases.add(release); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
  return fixture.terminal(id, dispatch);
});
function toggleOffline() {
  const online = navigator.onLine === false;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}
function releaseContinuity() {
  for (const id of ['instance:alpha', 'instance:beta']) if (fixture.waiting.has(id)) fixture.emit(id, []);
}
const shortcut = (event: KeyboardEvent) => {
  if (!event.altKey || !event.shiftKey) return;
  const key = event.key.toLowerCase();
  if (key === 'o') { event.preventDefault(); toggleOffline(); }
  else if (key === 'c') { event.preventDefault(); releaseContinuity(); }
};
document.addEventListener('keydown', shortcut);
function Qa() {
  return <main className="mx-auto max-w-4xl space-y-4 p-6 text-foreground"><h1 className="text-sm font-semibold">Macro Connect · Synthetic QA</h1>
    <p className="text-xs text-muted-foreground">DEV only. No account, vault, provider, native IPC or external requests. Local producer composition is not imported.</p>
    <div className="flex flex-wrap gap-3 text-xs"><button onClick={() => void i18n.changeLanguage(i18n.language === 'en' ? 'fr' : 'en')}>EN / FR</button><button onClick={() => fixture.changeAccount()}>Change synthetic account</button><button onClick={() => { if (fixture.waiting.has('instance:alpha')) fixture.emit('instance:alpha', [], true); }}>Reset Alpha stream</button><button onClick={releaseContinuity}>Release continuity · Alt+Shift+C</button><button onClick={() => { delayed = true; }}>Delay next Alpha reads</button><button onClick={() => { delayed = false; for (const release of [...releases]) release(); }}>Release Alpha reads</button><button onClick={() => { denied = !denied; }}>Toggle Alpha refusal · next read</button><button onClick={toggleOffline}>Toggle synthetic offline · Alt+Shift+O</button></div>
    <ConnectConsumerLauncher enabled createPorts={() => fixture.ports} />
  </main>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><Qa /></React.StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => { root.unmount(); fixture.owner()?.dispose(); document.removeEventListener('keydown', shortcut); for (const release of [...releases]) release(); });
