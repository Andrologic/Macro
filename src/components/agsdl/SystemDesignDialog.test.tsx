import { afterEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SystemDesignDialog } from './SystemDesignDialog';
import { createEmptySystem, readDesign, withDesign, type DesignMetadata } from '../../services/agsdl/design';
import { createLegacyExample } from '../../services/agsdl/examples';
import { agsdlSessionKey, useAgsdlStore } from '../../stores/useAgsdlStore';
import { AgsdlUserError } from '../../services/agsdl/userErrors';

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
async function mount(canEdit = true, onClose = () => {}, source = createEmptySystem('Release'), design?: DesignMetadata) {
  useAgsdlStore.setState({ sessions: { [key]: { source, design, annexes: {}, version: 'initial', persistedRevision: 1, dirty: false, saving: false, status: 'draft', history: [], future: [], reports: [], error: null } } });
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
  it('preserves editing of design metadata in a 0.1 source', async () => {
    const source = createLegacyExample('feature');
    await mount(true, () => {}, withDesign(source, readDesign(source)));
    purpose('A legacy design');
    useAgsdlStore.setState({ save: async () => {} });
    await submit();
    expect(readDesign(useAgsdlStore.getState().sessions[key].source).purpose).toBe('A legacy design');
  });
  it('fills a project value without exposing or changing its definition', async () => {
    const source = JSON.stringify({ ...JSON.parse(createEmptySystem('Release')), content: { guidance: { value: '' } } });
    const design = { ...readDesign(source), requirements: [{ id: 'command', label: 'Verification command', description: 'Use the project command.', value: '', targetPath: '/content/guidance/value' }] };
    await mount(true, () => {}, source, design);
    const input = document.body.querySelector<HTMLTextAreaElement>('.agsdl-requirement > textarea')!;
    expect(document.body.querySelector(`label[for="${input.id}"]`)?.textContent).toContain('Verification command');
    expect(document.body.querySelector('.agsdl-requirement-definition')).toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'bun run check');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    useAgsdlStore.setState({ save: async () => {} });
    await submit();
    expect(JSON.parse(useAgsdlStore.getState().sessions[key].source).content.guidance.value).toBe('bun run check');
    expect(readDesign(useAgsdlStore.getState().sessions[key].source, useAgsdlStore.getState().sessions[key].design).requirements).toEqual([{ ...design.requirements[0], value: 'bun run check' }]);
  });
  it('allows an incomplete rule to remain a saved draft even when its section is collapsed', async () => {
    const source = createEmptySystem('Release');
    await mount(true, () => {}, source, { ...readDesign(source), rules: [{ id: 'draft', title: '', instructions: '' }] });
    purpose('A draft process');
    expect(document.body.querySelector('form')!.checkValidity()).toBe(true);
    useAgsdlStore.setState({ save: async () => {} });
    await submit();
    expect(readDesign(useAgsdlStore.getState().sessions[key].source, useAgsdlStore.getState().sessions[key].design).rules[0].instructions).toBe('');
  });
  it('rejects a stale form while keeping the draft and concurrent source unchanged', async () => {
    await mount(); purpose('Prepare a release');
    act(() => useAgsdlStore.getState().edit(target, [{ op: 'set', path: '/id', valueJson: '"Concurrent agent edit"' }], 'initial'));
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
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('The action failed. Try again.');
    expect(document.body.textContent).not.toContain('Storage unavailable');
    expect(document.body.querySelector('textarea')?.disabled).toBe(true);
    const applied = useAgsdlStore.getState().sessions[key];
    expect(JSON.parse(applied.source)).not.toHaveProperty("annotations");
    expect(readDesign(applied.source, applied.design).purpose).toBe('Prepare a release');
    expect(closed).toBe(0);
    await submit();
    expect(attempts).toBe(2);
    expect(closed).toBe(1);
    expect(useAgsdlStore.getState().sessions[key].version).toBe(applied.version);
    expect(useAgsdlStore.getState().sessions[key].history).toHaveLength(1);
  });
  it('keeps a save the user must wait for as its translated reason', async () => {
    await mount(true); purpose('Prepare a release');
    useAgsdlStore.setState({ save: async () => { throw new AgsdlUserError('agsdl.userError.saving', 'A save is already in progress.'); } });
    await submit();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('Wait for the current save to finish.');
  });
  it('does not retry a saved draft over a newer agent edit', async () => {
    await mount(); purpose('Prepare a release');
    let attempts = 0;
    useAgsdlStore.setState({ save: async () => { attempts++; throw new Error('Storage unavailable'); } });
    await submit();
    act(() => useAgsdlStore.getState().edit(target, [{ op: 'set', path: '/id', valueJson: '"Newer edit"' }]));
    const latest = useAgsdlStore.getState().sessions[key];
    await submit();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('document changed');
    expect(attempts).toBe(1);
    expect(useAgsdlStore.getState().sessions[key]).toBe(latest);
  });
});
