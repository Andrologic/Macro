import { describe, expect, it } from 'bun:test';
import { applyChanges, validateDocument } from './document';
import { createEmptySystem, designChanges, readDesign } from './design';

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
