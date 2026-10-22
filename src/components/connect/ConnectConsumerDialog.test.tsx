import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import en from '../../i18n/locales/en.json';
import { createConnectConsumerFixture } from '../../../dev/fixtures/connectConsumer';
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, string>) => {
  const value = key.split('.').reduce((v: unknown, k) => v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined, en);
  return Object.entries(options ?? {}).reduce((text, [name, item]) => text.replace(`{{${name}}}`, item), typeof value === 'string' ? value : options?.defaultValue ?? key);
} }) }));
const { ConnectConsumerDialog } = await import('./ConnectConsumerDialog');
const { Dialog } = await import('../ui/Dialog');
const { ConnectConsumerLauncher } = await import('./ConnectConsumerLauncher');
let root: Root, container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });
const settle = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check() && Date.now() < end) await act(async () => { await new Promise(done => setTimeout(done, 3)); }); expect(check()).toBe(true); };
async function mount() {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  const fixture = createConnectConsumerFixture(); const close = mock(() => {});
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<StrictMode><Dialog title="Settings" onClose={() => {}}><ConnectConsumerDialog ports={fixture.ports} onClose={close} /></Dialog></StrictMode>));
  await settle(() => document.querySelectorAll('option').length === 4); return { fixture, close };
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!; }
async function add(id: string) {
  await act(async () => { const select = document.querySelector<HTMLSelectElement>('select[aria-label="Choose a computer"]')!; select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Add computer').click()); await settle(() => Boolean(button(id === 'instance:alpha' ? 'Alpha Chat 1' : 'Beta Chat 1')) || document.body.textContent!.includes(id === 'instance:alpha' ? 'Alpha Chat 1' : 'Beta Chat 1'));
}
describe('Connect reader DOM', () => {
  it('creates no owner before opening the real launcher and releases it when closing', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    const fixture = createConnectConsumerFixture(), createPorts = mock(() => fixture.ports);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<StrictMode><ConnectConsumerLauncher enabled createPorts={createPorts} /></StrictMode>));
    const opener = button('Open reader'); opener.focus(); expect(createPorts).not.toHaveBeenCalled(); expect(fixture.owner()).toBeUndefined();
    await act(async () => opener.click()); await settle(() => document.querySelectorAll('option').length === 4); await add('instance:alpha');
    expect(createPorts).toHaveBeenCalledTimes(1); expect(fixture.owner()!.diagnostics().targets).toBe(1);
    await act(async () => button('Close').click()); await settle(() => document.querySelector('[role="dialog"]') === null);
    expect(fixture.owner()!.diagnostics()).toMatchObject({ targets: 0, subscribers: 0 }); expect(fixture.listeners.size).toBe(0); expect(document.activeElement).toBe(opener);
  });

  it('mounts in StrictMode, renders equal IDs independently as passive text and restores close semantics', async () => {
    const { fixture, close } = await mount(); await add('instance:alpha'); await add('instance:beta');
    for (const title of ['Alpha Chat 1', 'Beta Chat 1']) await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(title))!.click());
    await settle(() => document.body.textContent!.includes('instance:alpha message') && document.body.textContent!.includes('instance:beta message'));
    expect(document.querySelectorAll('img,video,iframe,a[href]')).toHaveLength(0); expect(document.body.textContent).toContain('<img src='); expect(fixture.owner()!.diagnostics().subscribers).toBe(4);
    const dialogs = document.querySelectorAll('[role="dialog"]'); expect(dialogs).toHaveLength(2);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(close).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount()); expect(fixture.owner()!.diagnostics()).toMatchObject({ targets: 0, subscribers: 0 }); expect(fixture.listeners.size).toBe(0);
  });
  it('removes protected DOM when hidden and closes after a context change', async () => {
    const { fixture, close } = await mount(); await add('instance:alpha'); expect(document.body.textContent).toContain('Alpha Chat 1');
    await act(async () => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    expect(document.body.textContent).not.toContain('Alpha Chat 1'); expect(document.body.textContent).not.toContain('Alpha PC'); expect(fixture.owner()!.diagnostics().subscribers).toBe(0);
    await act(async () => fixture.changeAccount()); expect(close).toHaveBeenCalled();
  });
});
