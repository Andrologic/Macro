import { afterEach, expect, it, mock } from 'bun:test';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import en from '../../i18n/locales/en.json';
import { createConnectConsumerFixture } from '../../../dev/fixtures/connectConsumer';
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => {
  const value = key.split('.').reduce((v: unknown, k) => v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined, en);
  return typeof value === 'string' ? value : options?.defaultValue ?? key;
} }) }));
const { TransferConversationDialog } = await import('./TransferConversationDialog');
let root: Root, container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });
const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check() && Date.now() < end) await act(async () => { await new Promise(done => setTimeout(done, 5)); }); expect(check()).toBe(true); };
async function mount() {
  const fixture = createConnectConsumerFixture();
  fixture.directoryRead(async request => { const page = fixture.directory(request); if (request.item_type === 'instance_access') for (const access of page.items) if ('permissions' in access) access.permissions = ['supervise', 'respond']; return page; });
  let removed = false; const reads: string[] = [];
  fixture.read(async (id, dispatch) => {
    if (dispatch.kind !== 'submit' || dispatch.request.operation !== 'instance.models') throw Error('unexpected read');
    reads.push(id); const original = id === 'instance:alpha';
    return { contract_version: '2.0', type: 'response', operation: 'instance.models', account_id: fixture.ports.context().accountId, request_id: dispatch.request.request_id,
      result: { instance_id: id, observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30000).toISOString(), models: removed ? [] : [{ provider_id: original ? 'macro-ai' : 'chatgpt', provider_name: original ? 'Macro AI' : 'Codex', model_id: original ? 'original' : 'alternative', model_name: 'Synthetic model', reasoning_efforts: [] }] } };
  });
  const send = mock(async () => 'target-chat'), close = mock(() => {}), complete = mock(() => {});
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<StrictMode><TransferConversationDialog ports={fixture.ports} source={{ id: 'source-chat', title: 'Global chat', providerId: 'macro-ai', modelId: 'original' }} send={send} onClose={close} onTransferred={complete} /></StrictMode>));
  await until(() => document.querySelectorAll('select')[0]?.querySelectorAll('option').length === 3);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  return { fixture, send, close, complete, reads, remove: () => { removed = true; } };
}
async function select(index: number, value: string) { await act(async () => { const input = document.querySelectorAll('select')[index]; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); }); }
function transfer() { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Transfer')!; }
it('retains the source model, rechecks before freeze and submits one selected target', async () => {
  const h = await mount(); await select(0, 'instance:alpha'); await until(() => document.querySelectorAll('select').length === 2);
  expect(document.querySelectorAll('select')[1].value).toBe(JSON.stringify(['macro-ai', 'original']));
  expect(h.send).not.toHaveBeenCalled(); await act(async () => transfer().click()); await until(() => h.complete.mock.calls.length === 1);
  expect(h.reads).toEqual(['instance:alpha', 'instance:alpha']); expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.send).toHaveBeenCalledWith('instance:alpha', { providerId: 'macro-ai', modelId: 'original' });
});
it('requires an explicit alternative and blocks a removed model before native send', async () => {
  const h = await mount(); await select(0, 'instance:beta'); await until(() => document.querySelectorAll('select').length === 2);
  expect(transfer().disabled).toBe(true); expect(document.body.textContent).toContain('Choose an alternative');
  await select(1, JSON.stringify(['chatgpt', 'alternative'])); expect(transfer().disabled).toBe(false); h.remove();
  await act(async () => transfer().click()); await until(() => Boolean(document.querySelector('[role="alert"]')));
  expect(h.send).not.toHaveBeenCalled(); expect(transfer().disabled).toBe(true);
});
it('retires target choices on an account change without calling native transfer', async () => {
  const h = await mount(); await select(0, 'instance:alpha'); await until(() => document.querySelectorAll('select').length === 2);
  await act(async () => h.fixture.changeAccount()); await until(() => Boolean(document.querySelector('[role="alert"]')));
  expect(transfer().disabled).toBe(true); expect(h.send).not.toHaveBeenCalled();
});
