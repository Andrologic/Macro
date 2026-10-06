import { expect, it } from 'bun:test';
import { captureComposerSnapshot, sameComposerSnapshot, persistableContextRefs, submissionHiddenContext } from './composerSubmission';
import { COMPOSER_REFERENCE_PATTERN, referenceId, referenceText } from './composerReferenceText';
import type { AgsdlSelectionReference, ContextReference } from '../../types';

it('captures selection metadata independently of later draft mutations', () => {
  const selection: AgsdlSelectionReference = { id: 'a', conversationId: 'c', branchName: 'develop', planId: 'p', document: 'agsdl', version: 'v1', persistedRevision: 1, path: '', title: 'System' };
  const ref: ContextReference = { id: 'a', kind: 'agsdl', title: 'System', data: selection };
  const draft = { text: 'Review', images: [], contextRefs: [ref] };
  const snapshot = captureComposerSnapshot(draft);
  expect(sameComposerSnapshot(snapshot, draft)).toBe(true);
  selection.version = 'v2';
  expect(sameComposerSnapshot(snapshot, draft)).toBe(false);
  expect(persistableContextRefs(snapshot.contextRefs)?.[0].agsdl?.version).toBe('v1');
});

it('keeps identity for equal titles, punctuation and legacy markers', () => {
  const text = `${referenceText('file', '/a/README.md', 'README.md')} ${referenceText('file', '/b/README.md', 'README.md')}`;
  const matches = [...text.matchAll(new RegExp(COMPOSER_REFERENCE_PATTERN))];
  expect(matches.map(match => referenceId(match))).toEqual(['/a/README.md', '/b/README.md']);
  expect(referenceId([...referenceText('agsdl', 'id (1)', 'A ] B').matchAll(new RegExp(COMPOSER_REFERENCE_PATTERN))][0])).toBe('id (1)');
  expect(referenceId([...('[skill: old]').matchAll(new RegExp(COMPOSER_REFERENCE_PATTERN))][0])).toBeUndefined();
});

it('never resolves a missing or malformed stable identity by its title', async () => {
  const { resolveReference } = await import('./composerReferenceText');
  const refs = [{ kind: 'file' as const, id: 'actual', title: 'README' }];
  const parse = (value: string) => [...value.matchAll(new RegExp(COMPOSER_REFERENCE_PATTERN))][0];
  expect(resolveReference(parse(referenceText('file', 'missing', 'README')), refs)).toBeUndefined();
  expect(resolveReference(parse('[file: README](macro-context://skill/actual)'), refs)).toBeUndefined();
  expect(resolveReference(parse('[file: README]'), refs)).toEqual(refs[0]);
  expect(resolveReference(parse('[file: README]'), [...refs, { ...refs[0], id: 'other' }])).toBeUndefined();
});

it('rejects multiple AgSDL selections even with supplied hidden context', () => {
  const refs = [
    { id: 'first', kind: 'agsdl' as const, title: 'First' },
    { id: 'foreign', kind: 'agsdl' as const, title: 'Foreign' },
  ];
  expect(() => submissionHiddenContext(refs)).toThrow('Only one AgSDL selection');
  expect(() => submissionHiddenContext(refs, '<agsdl_selection>existing</agsdl_selection>')).toThrow('Only one AgSDL selection');
});

it('transmits only AgSDL context when message editing preserves preceding metadata', async () => {
  const { agsdlContextForModel } = await import('../agsdl/chatContextPayload');
  const selection: AgsdlSelectionReference = { id: 'a', conversationId: 'c', branchName: 'develop', planId: 'p', document: 'agsdl', version: 'v1', persistedRevision: 1, path: '', title: 'System </agsdl_selection>' };
  const refs = [{ id: 'a', kind: 'agsdl' as const, title: selection.title, agsdl: selection }];
  const hidden = submissionHiddenContext(refs, 'Preserved message metadata')!;
  expect(hidden).toStartWith('Preserved message metadata');
  const model = agsdlContextForModel(hidden)!;
  expect(model).toContain('"plan_id":"p"');
  expect(model).toContain('System </agsdl_selection>');
  expect(model).not.toContain('Preserved message metadata');
  expect(submissionHiddenContext(refs, hidden)).toBe(hidden);
});


it('preserves conversation and AgSDL identities through the shared composer contract', () => {
  const selection: AgsdlSelectionReference = { id: 'agent', conversationId: 'target', branchName: 'develop', planId: 'plan', document: 'agsdl', version: 'v1', persistedRevision: 1, path: '/agents/helper', title: 'Prior work' };
  const refs: ContextReference[] = [
    { id: 'source', kind: 'conversation', title: 'Prior work', data: { conversationId: 'source' } },
    { id: 'agent', kind: 'agsdl', title: 'Prior work', data: selection },
  ];
  const snapshot = captureComposerSnapshot({ text: 'Compare', images: [], contextRefs: refs });
  const persisted = persistableContextRefs(snapshot.contextRefs)!;
  expect(persisted[0]).toMatchObject({ id: 'source', kind: 'conversation', conversationId: 'source' });
  expect(persisted[1].agsdl).toEqual(selection);
  const markers = refs.map(ref => referenceText(ref.kind, ref.id, ref.title)).join(' ');
  const matches = [...markers.matchAll(new RegExp(COMPOSER_REFERENCE_PATTERN))];
  expect(matches.map(match => [match[1], referenceId(match)])).toEqual([
    ['conversation', 'source'], ['agsdl', 'agent'],
  ]);
});
