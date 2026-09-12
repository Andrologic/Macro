import { afterEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SystemDesignDialog } from './SystemDesignDialog';
import { createEmptySystem, readDesign } from '../../services/agsdl/design';
import { agsdlSessionKey, useAgsdlStore } from '../../stores/useAgsdlStore';

const target = { branchName: 'develop', planId: 'system-design' };
const key = agsdlSessionKey(target);
const originalSave = useAgsdlStore.getState().save;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  useAgsdlStore.setState({ sessions: {}, save: originalSave });
});
async function mount(canEdit = true, onClose = () => {}) {
  const source = createEmptySystem('Release');
  useAgsdlStore.setState({ sessions: { [key]: { source, annexes: {}, version: 'initial', persistedRevision: 1, dirty: false, saving: false, status: 'draft', history: [], future: [], reports: [], error: null } } });
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<SystemDesignDialog target={target} onClose={onClose} canEdit={canEdit} />));
}
function purpose(value: string) {
  act(() => {
    const input = document.body.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = () => act(async () => {
  document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
});

describe('system design editing', () => {
  it('rejects a stale form while keeping the draft and concurrent source unchanged', async () => {
    await mount(); purpose('Prepare a release');
    act(() => useAgsdlStore.getState().edit(target, [{ op: 'set', path: '/root/annotations/title', valueJson: '"Concurrent agent edit"' }], 'initial'));
    const current = useAgsdlStore.getState().sessions[key].source;
    let saves = 0;
    useAgsdlStore.setState({ save: async () => { saves++; } });
    await submit();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('document changed');
    expect(document.body.querySelector('textarea')?.value).toBe('Prepare a release');
    expect(useAgsdlStore.getState().sessions[key].source).toBe(current);
    expect(saves).toBe(0);
  });
  it('keeps a draft session read-only when the surrounding plan denies editing', async () => {
    await mount(false);
    const source = useAgsdlStore.getState().sessions[key].source;
    expect(document.body.querySelector('textarea')?.disabled).toBe(true);
    expect(document.body.querySelector('footer')).toBeNull();
    let saves = 0;
    useAgsdlStore.setState({ save: async () => { saves++; } });
    await submit(); // The handler must enforce the lock, even if a submit is dispatched.
    expect(saves).toBe(0);
    expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
  });
  it('retries a failed save using the applied version without applying metadata twice', async () => {
    let closed = 0;
    await mount(true, () => { closed++; }); purpose('Prepare a release');
    let attempts = 0;
    useAgsdlStore.setState({ save: async () => { if (++attempts === 1) throw new Error('Storage unavailable'); } });
    await submit();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Storage unavailable');
    expect(document.body.querySelector('textarea')?.disabled).toBe(true);
    const applied = useAgsdlStore.getState().sessions[key];
    expect(readDesign(applied.source).purpose).toBe('Prepare a release');
    expect(closed).toBe(0);
    await submit();
    expect(attempts).toBe(2);
    expect(closed).toBe(1);
    expect(useAgsdlStore.getState().sessions[key].version).toBe(applied.version);
    expect(useAgsdlStore.getState().sessions[key].history).toHaveLength(1);
  });
  it('does not retry a saved draft over a newer agent edit', async () => {
    await mount(); purpose('Prepare a release');
    let attempts = 0;
    useAgsdlStore.setState({ save: async () => { attempts++; throw new Error('Storage unavailable'); } });
    await submit();
    act(() => useAgsdlStore.getState().edit(target, [{ op: 'set', path: '/root/annotations/title', valueJson: '"Newer edit"' }]));
    const latest = useAgsdlStore.getState().sessions[key];
    await submit();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('document changed');
    expect(attempts).toBe(1);
    expect(useAgsdlStore.getState().sessions[key]).toBe(latest);
  });
});
