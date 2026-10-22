import { describe, expect, it } from 'bun:test';
import { applyChanges, validateDocument } from './document';
import { createLegacyEmptySystem as createEmptySystem, designChanges, readDesign } from './design';

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

import { createEmptySystemDocument, manualMigrationInventory, withDocumentDesign } from './design';
import { createExample, createExampleDocument, AGSDL_EXAMPLES } from './examples';

describe('AgSDL 0.2 design envelopes', () => {
  it('keeps Macro metadata outside the closed document and preserves source exactly', async () => {
    const draft = createEmptySystemDocument('Préparer la release');
    const source = draft.source.replace('"agents": {}', '"agents" : {}');
    const changed = withDocumentDesign(source, { ...readDesign(source, draft.design), purpose: 'Publier après vérification' }, draft);
    expect(changed.source).toBe(source);
    expect(readDesign(changed.source, changed.design).purpose).toBe('Publier après vérification');
    expect(JSON.parse(changed.source)).toEqual({ contract: 'agsdl-0.2.0', id: JSON.parse(source).id, agents: {}, configurations: {}, bindings: {} });
    expect(changed.display?.title).toBe('Préparer la release');
    expect((await validateDocument(source))[0].results.every(result => result.verdict === 'pass')).toBe(true);
    expect(() => designChanges(source, readDesign(source))).toThrow('envelope');
  });
  it('rejects malformed envelope metadata without discarding it', () => {
    const draft = createEmptySystemDocument('Test');
    const malformed = { ...draft.design!, version: 2 };
    expect(() => readDesign(draft.source, malformed as never)).toThrow('preserved');
  });
  it('keeps existing row extensions and supports removal of optional target paths', () => {
    const draft = createEmptySystemDocument('Test');
    const design = { ...draft.design!, requirements: [{ id: 'guide', label: 'Guide', description: '', value: '', targetPath: '/content/guide/value', extension: 'retained' }] };
    const next = { ...design, requirements: [{ id: 'guide', label: 'Instructions', description: '', value: 'Check evidence' }] };
    const updated = withDocumentDesign(draft.source, next, { design });
    expect(updated.design?.requirements[0] as unknown).toEqual({ id: 'guide', label: 'Instructions', description: '', value: 'Check evidence', extension: 'retained' });
  });
  it('inventories a manual migration while retaining original source bytes', () => {
    const source = createEmptySystem('Historical');
    const inventory = manualMigrationInventory(source);
    expect(inventory.originalSource).toBe(source);
    expect(inventory.to).toBe('agsdl-0.2.0');
    expect(inventory.requiresAuthoring).toContain('persistent-agent-lifecycle');
    expect(JSON.parse(source).contract).toBe('agsdl-0.1.0');
  });
  it('ships human labels as presentation metadata without adding source fields', () => {
    const document = createExampleDocument('release'), doc = JSON.parse(document.source);
    expect(document.display?.cards?.['/agents/review'].title).toBe('PR review');
    expect(document.display?.cards?.['/flow/steps/review'].title).toBe('PR review');
    expect(doc.agents.review.title).toBeUndefined();
    expect(doc.bindings.engine.contract.identity).toBe('macro/agent-engine');
    expect(doc.configurations.project.settings?.providerId).toBeUndefined();
    expect(doc.configurations.project.settings?.access).toBeUndefined();
    expect(doc.bindings.engine.claims).toBeUndefined();
  });
  it('creates valid 0.2 examples with authored configurations and explicit transfer', async () => {
    for (const kind of AGSDL_EXAMPLES) {
      const source = createExample(kind), doc = JSON.parse(source);
      expect(doc.contract).toBe('agsdl-0.2.0');
      expect(doc.root).toBeUndefined();
      expect(doc.configurations.project.engine).toBe('engine');
      expect(doc.bindings.engine.implementation.identity).toBe('macro/desktop');
      expect(Object.values(doc.flow.steps).some(step => (step as {type: string}).type === 'prepare')).toBe(true);
      const reports = await validateDocument(source);
      expect(reports.flatMap(report => report.results).every(result => result.verdict === 'pass')).toBe(true);
    }
  });
});

import { adaptationChanges, defaultDesign } from './design';

describe('adaptation support assertions', () => {
  const requirement = { contract: { identity: 'example/support', version: '1' } };
  const claims = [{ requirement, status: 'supported', evidence: 'a'.repeat(64) }];
  const source = JSON.stringify({ contract: 'agsdl-0.2.0', id: 'adapted', agents: {},
    configurations: { changed: { engine: 'changed', settings: { region: 'old', locale: 'old' }, requires: [requirement], claims }, untouched: { engine: 'untouched', claims } },
    bindings: { changed: { contract: { identity: 'example/engine', version: '1' }, implementation: { identity: 'example/local', version: '1' }, settings: { region: 'old' }, claims }, untouched: { contract: { identity: 'example/tool', version: '1' }, implementation: { identity: 'example/tool-local', version: '1' }, claims } },
    content: { guidance: { value: 'old' } },
  });
  const designFor = (paths: string[]) => ({ ...defaultDesign(), requirements: paths.map((targetPath, index) => ({ id: `field-${index}`, label: 'Field', description: '', value: 'old', targetPath })) });
  it('invalidates only the adapted configuration and binding, once per declaration', () => {
    const before = designFor(['/configurations/changed/settings/region', '/configurations/changed/settings/locale', '/bindings/changed/settings/region']);
    const changes = adaptationChanges(source, before, { ...before, requirements: before.requirements.map(row => ({ ...row, value: 'new' })) });
    expect(changes.filter(change => change.op === 'remove')).toEqual([
      { op: 'remove', path: '/configurations/changed/claims' }, { op: 'remove', path: '/bindings/changed/claims' },
    ]);
    const updated = JSON.parse(applyChanges(source, changes));
    expect(updated.configurations.changed.settings).toEqual({ region: 'new', locale: 'new' });
    expect(updated.bindings.changed.settings.region).toBe('new');
    expect(updated.configurations.changed.claims).toBeUndefined();
    expect(updated.bindings.changed.claims).toBeUndefined();
    expect(updated.configurations.untouched.claims).toEqual(claims);
    expect(updated.bindings.untouched.claims).toEqual(claims);
  });
  it('preserves assertions when content changes or the source value already matches', () => {
    const content = designFor(['/content/guidance/value']);
    const updated = JSON.parse(applyChanges(source, adaptationChanges(source, content, { ...content, requirements: [{ ...content.requirements[0], value: 'new' }] })));
    expect(updated.content.guidance.value).toBe('new');
    expect(updated.configurations.changed.claims).toEqual(claims);
    expect(updated.bindings.changed.claims).toEqual(claims);
    const before = designFor(['/configurations/changed/settings/region']);
    before.requirements[0].value = '';
    expect(adaptationChanges(source, before, { ...before, requirements: [{ ...before.requirements[0], value: 'old' }] })).toEqual([]);
  });
});

it('preserves blueprint provenance when ordinary design edits omit origin in both editions', () => {
  const origin = { branchName: 'develop', planId: 'blueprint', name: 'Blueprint', revision: 2 };
  const next = { ...defaultDesign(), context: 'Edited context' };
  const modern = createEmptySystemDocument('Copy');
  modern.design!.origin = origin;
  expect(withDocumentDesign(modern.source, next, modern).design?.origin).toEqual(origin);
  expect(withDocumentDesign(modern.source, { ...next, origin: { planId: 'blueprint', name: 'Blueprint', revision: 2 } }, modern).design?.origin).toEqual(origin);
  const legacy = JSON.parse(createEmptySystem('Copy'));
  legacy.root.annotations.macroDesign.origin = origin;
  const edited = applyChanges(JSON.stringify(legacy), designChanges(JSON.stringify(legacy), next));
  expect(readDesign(edited).origin).toEqual(origin);
  expect(readDesign(edited).context).toBe('Edited context');
});
