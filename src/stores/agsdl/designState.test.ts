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
  it('clears newly added optional metadata when undo restores an envelope without those fields', () => {
    const store = useAgsdlStore.getState(), source = state().source;
    store.replace(target, source, {}, state().version, {});
    const empty = structuredClone(state());
    store.replace(target, source, {}, state().version, { design: readDesign(source), display: { title: 'Imported' }, migration: { version: 1, from: 'agsdl-0.1.0', issues: [] } });
    store.undo(target);
    expect(state().source).toBe(empty.source);
    expect(state().design).toBeUndefined();
    expect(state().display).toBeUndefined();
    expect(state().migration).toBeUndefined();
  });
  it('clears suppressed optional metadata again when redoing its removal', () => {
    const store = useAgsdlStore.getState(), source = state().source;
    const metadata = { design: state().design!, display: { title: 'Imported' }, migration: { version: 1 as const, from: 'agsdl-0.1.0' as const, issues: [] } };
    store.replace(target, source, {}, state().version, metadata);
    store.replace(target, source, {}, state().version, {});
    store.undo(target);
    expect(state().migration).toEqual(metadata.migration);
    expect(state().display).toEqual(metadata.display);
    expect(state().design).toEqual(metadata.design);
    store.undo(target, true);
    expect(state().design).toBeUndefined();
    expect(state().display).toBeUndefined();
    expect(state().migration).toBeUndefined();
  });
  it('counts only envelope metadata when a full editor document is passed to replace', () => {
    const document = createEmptySystemDocument('Large draft');
    const source = JSON.stringify({ ...JSON.parse(document.source), content: { guide: { value: 'a'.repeat(600 * 1024) } } });
    document.source = source;
    useAgsdlStore.getState().replace(target, source, {}, state().version, document);
    expect(state().source).toBe(source);
    expect(state().display?.title).toBe('Large draft');
  });
  it('rejects stale metadata updates before changing source or history', () => {
    const before = structuredClone(state());
    expect(() => useAgsdlStore.getState().setDesign(target, { ...state().design!, purpose: 'Stale' }, 'old')).toThrow('changed');
    expect(state()).toEqual(before);
  });
});

it('preserves copy provenance through design updates, envelope replacement and source edits', () => {
  const store = useAgsdlStore.getState();
  const origin = { branchName: 'develop', planId: 'blueprint', name: 'Blueprint', revision: 1 };
  store.setDesign(target, { ...state().design!, origin });
  const { origin: _omitted, ...design } = state().design!;
  store.setDesign(target, { ...design, context: 'Edited' });
  expect(state().design!.origin).toEqual(origin);
  store.replace(target, state().source, undefined, undefined, { design });
  expect(state().design!.origin).toEqual(origin);
  store.replace(target, state().source, undefined, undefined, {});
  expect(state().design!.origin).toEqual(origin);
  store.edit(target, [{ op: 'set', path: '/id', valueJson: '"edited-copy"' }]);
  expect(state().design!.origin).toEqual(origin);
});
