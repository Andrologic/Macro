import { beforeEach, describe, expect, it } from 'bun:test';
import { agsdlSessionKey, useAgsdlStore, type AgsdlSession } from '../useAgsdlStore';
import { createEmptySystemDocument, readDesign } from '../../services/agsdl/design';
const target = { branchName: 'feature/design-envelope', planId: 'test' }, key = agsdlSessionKey(target);
const state = () => useAgsdlStore.getState().sessions[key];
beforeEach(() => {
  const draft = createEmptySystemDocument('Test');
  const session: AgsdlSession = { ...draft, version: 'v1', persistedRevision: 1, dirty: false, saving: false, status: 'draft', history: [], future: [], reports: [], error: null };
  useAgsdlStore.setState({ sessions: { [key]: session } });
});
describe('Macro design metadata history', () => {
  it('stores, undoes and redoes metadata edits without changing source bytes', () => {
    const source = state().source;
    useAgsdlStore.getState().setDesign(target, { ...readDesign(source, state().design), purpose: 'Check evidence' }, 'v1');
    expect(state().source).toBe(source);
    expect(state().design?.purpose).toBe('Check evidence');
    expect(state().dirty).toBe(true);
    useAgsdlStore.getState().undo(target);
    expect(state().design?.purpose).toBe('');
    expect(state().source).toBe(source);
    useAgsdlStore.getState().undo(target, true);
    expect(state().design?.purpose).toBe('Check evidence');
    expect(state().source).toBe(source);
  });
  it('preserves metadata across source patches and clones imported envelopes', () => {
    const draft = createEmptySystemDocument('Pinned');
    useAgsdlStore.getState().replace(target, draft.source, {}, 'v1', draft);
    draft.display!.title = 'Changed outside';
    expect(state().display?.title).toBe('Pinned');
    useAgsdlStore.getState().edit(target, [{ op: 'set', path: '/id', valueJson: '"updated"' }]);
    expect(state().display?.title).toBe('Pinned');
  });
  it('applies blueprint guidance to its existing authored content slot and undoes both atomically', () => {
    const source = JSON.stringify({ contract: 'agsdl-0.2.0', id: 'test', agents: {}, configurations: {}, bindings: {}, content: { guide: { value: 'Placeholder' } } });
    const design = { ...state().design!, requirements: [{ id: 'guide', label: 'Guidance', description: '', value: '', targetPath: '/content/guide/value' }] };
    useAgsdlStore.getState().replace(target, source, {}, 'v1', { design });
    const version = state().version;
    useAgsdlStore.getState().setDesign(target, { ...design, requirements: [{ ...design.requirements[0], value: 'Run the project checks.' }] }, version);
    expect(JSON.parse(state().source).content.guide.value).toBe('Run the project checks.');
    expect(state().design?.requirements[0].value).toBe('Run the project checks.');
    useAgsdlStore.getState().undo(target);
    expect(state().source).toBe(source);
    expect(state().design?.requirements[0].value).toBe('');
  });
  it('rejects stale metadata updates before changing source or history', () => {
    const before = structuredClone(state());
    expect(() => useAgsdlStore.getState().setDesign(target, { ...state().design!, purpose: 'Stale' }, 'old')).toThrow('changed');
    expect(state()).toEqual(before);
  });
});
