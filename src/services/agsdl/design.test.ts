import { describe,expect,it } from 'bun:test';
import { createLegacyEmptySystem as createEmptySystem,designChanges,readDesign } from './design';
import { applyChanges,validateDocument } from './document';

describe('system design metadata', () => {
  it('creates a valid declaration draft without inventing a graph or runtime', async () => {
    const source = createEmptySystem('Release');
    const doc = JSON.parse(source);
    expect(doc.graphs).toBeUndefined();
    expect(doc.runtime).toBeUndefined();
    const reports = await validateDocument(source);
    expect(reports[0].results.every(result => result.verdict === 'pass')).toBe(true);
  });
  it('preserves opaque metadata and unrelated exact source bytes', () => {
    let source = createEmptySystem('Release');
    source = source.replace('"purpose": ""', '"opaque": 9007199254740993123, "purpose": ""');
    const updated = applyChanges(source, designChanges(source, { ...readDesign(source), purpose: 'Préparer la release' }));
    expect(updated).toBe(source.replace('"purpose": ""', '"purpose": "Préparer la release"'));
    expect(designChanges(updated, readDesign(updated))).toEqual([]);
  });
  it('preserves opaque numbers in reordered rows and removes an optional owned field', () => {
    const doc = JSON.parse(createEmptySystem('Test'));
    doc.root.annotations.macroDesign.requirements = [{ id: 'a', label: 'A', description: '', value: '', targetPath: '/definitions/0' }, { id: 'b', label: 'B', description: '', value: '' }];
    const source = JSON.stringify(doc).replace('"id":"a"', '"opaque":9007199254740993123,"id":"a"');
    const design = readDesign(source);
    delete design.requirements[0].targetPath;
    design.requirements.reverse();
    const updated = applyChanges(source, designChanges(source, design));
    expect(updated).toContain('"opaque":9007199254740993123');
    expect(readDesign(updated).requirements.map(item => item.id)).toEqual(['b', 'a']);
    expect(readDesign(updated).requirements[1].targetPath).toBeUndefined();
  });
  it('rejects incompatible, malformed and duplicate metadata rather than resetting it', () => {
    const source = createEmptySystem('Test');
    const doc = JSON.parse(source);
    doc.root.annotations.macroDesign.version = 2;
    expect(() => readDesign(JSON.stringify(doc))).toThrow();
    expect(() => designChanges(JSON.stringify(doc), readDesign(source))).toThrow();
    doc.root.annotations.macroDesign.version = 1;
    doc.root.annotations.macroDesign.requirements = [{ id: 'x', label: 'X', description: '', value: '' }, { id: 'x', label: 'X', description: '', value: '' }];
    expect(() => readDesign(JSON.stringify(doc))).toThrow();
  });
  it('adds metadata without replacing other annotations and preserves row extensions', () => {
    const doc = JSON.parse(createEmptySystem('Test'));
    delete doc.root.annotations.macroDesign;
    doc.root.annotations.other = { extension: 'kept' };
    let source = JSON.stringify(doc);
    const design = readDesign(source);
    design.rules = [{ id: 'review', title: 'Review', instructions: 'Check evidence.' }];
    source = applyChanges(source, designChanges(source, design));
    expect(JSON.parse(source).root.annotations.other).toEqual({ extension: 'kept' });
    const extended = JSON.parse(source);
    extended.root.annotations.macroDesign.rules[0].extension = 'keep';
    source = JSON.stringify(extended);
    design.rules[0].title = 'Peer review';
    expect(JSON.parse(applyChanges(source, designChanges(source, design))).root.annotations.macroDesign.rules[0].extension).toBe('keep');
  });
});

import { createEmptySystemDocument,withDocumentDesign } from './design';

describe('AgSDL 0.3 design envelopes', () => {
  it('keeps Macro metadata outside the closed document and preserves source exactly', async () => {
    const draft = createEmptySystemDocument('Préparer la release', 'agsdl-0.3.0');
    const source = draft.source.replace('"agents": {}', '"agents" : {}');
    const changed = withDocumentDesign(source, { ...readDesign(source, draft.design), purpose: 'Publier après vérification' }, draft);
    expect(changed.source).toBe(source);
    expect(readDesign(changed.source, changed.design).purpose).toBe('Publier après vérification');
    expect(JSON.parse(changed.source)).toEqual({ contract: 'agsdl-0.3.0', id: JSON.parse(source).id, title: 'Préparer la release', agents: {} });
    expect(changed.display?.title).toBe('Préparer la release');
    expect((await validateDocument(source))[0].results.every(result => result.verdict === 'pass')).toBe(true);
    expect(() => designChanges(source, readDesign(source))).toThrow('envelope');
  });
  it('rejects malformed envelope metadata without discarding it', () => {
    const draft = createEmptySystemDocument('Test', 'agsdl-0.3.0');
    const malformed = { ...draft.design!, version: 2 };
    expect(() => readDesign(draft.source, malformed as never)).toThrow('preserved');
  });
  it('keeps existing row extensions and supports removal of optional target paths', () => {
    const draft = createEmptySystemDocument('Test', 'agsdl-0.3.0');
    const design = { ...draft.design!, requirements: [{ id: 'guide', label: 'Guide', description: '', value: '', targetPath: '/content/guide/value', extension: 'retained' }] };
    const next = { ...design, requirements: [{ id: 'guide', label: 'Instructions', description: '', value: 'Check evidence' }] };
    const updated = withDocumentDesign(draft.source, next, { design });
    expect(updated.design?.requirements[0] as unknown).toEqual({ id: 'guide', label: 'Instructions', description: '', value: 'Check evidence', extension: 'retained' });
  });
});

import { defaultDesign,retainDesignOrigin } from './design';

it('preserves blueprint provenance when ordinary design edits omit origin in both editions', () => {
  const origin = { branchName: 'develop', planId: 'blueprint', name: 'Blueprint', revision: 2 };
  const next = { ...defaultDesign(), context: 'Edited context' };
  const modern = createEmptySystemDocument('Copy', 'agsdl-0.3.0');
  modern.design!.origin = origin;
  expect(withDocumentDesign(modern.source, next, modern).design?.origin).toEqual(origin);
  expect(withDocumentDesign(modern.source, { ...next, origin: { planId: 'blueprint', name: 'Blueprint', revision: 2 } }, modern).design?.origin).toEqual(origin);
  expect(withDocumentDesign(modern.source, { ...next, origin: { ...origin, branchName: undefined } }, modern).design?.origin).toEqual(origin);
  const legacy = JSON.parse(createEmptySystem('Copy'));
  legacy.root.annotations.macroDesign.origin = origin;
  const edited = applyChanges(JSON.stringify(legacy), designChanges(JSON.stringify(legacy), next));
  expect(readDesign(edited).origin).toEqual(origin);
  expect(readDesign(edited).context).toBe('Edited context');
});

it.each([null, 7, {}, { planId: 'blueprint' }, { planId: 'blueprint', name: 'Blueprint', revision: 1, branchName: null }, { planId: 'blueprint', name: 'Blueprint', revision: 1, branchName: 7 }])('rejects malformed provenance before retaining the previous origin: %j', origin => {
  const previous = { ...defaultDesign(), origin: { branchName: 'develop', planId: 'blueprint', name: 'Blueprint', revision: 1 } };
  expect(() => retainDesignOrigin(previous, { ...defaultDesign(), origin } as never)).toThrow('design metadata');
});

it('allows an origin without a branch when none was previously captured', () => {
  const design = { ...defaultDesign(), origin: { planId: 'blueprint', name: 'Blueprint', revision: 1 } };
  expect(retainDesignOrigin(design, { ...design, origin: { ...design.origin, branchName: undefined } })?.origin?.branchName).toBeUndefined();
});
