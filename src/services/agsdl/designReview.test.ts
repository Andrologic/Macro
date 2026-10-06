import { describe, expect, it } from 'bun:test';
import { readDesign, withDesign } from "./design";
import { createLegacyExample as createExample, createExample as createExample020 } from './examples';
import { reviewDesignChanges } from './designReview';
import { applyChanges } from './document';
const original = () => createExample('release');
const edit = (source: string, change: (doc: ReturnType<typeof JSON.parse>) => void) => { const doc = JSON.parse(source); change(doc); return JSON.stringify(doc); };
describe('authored design changes', () => {
  it('shows the changed project value without exposing metadata identifiers', () => {
    const base = original();
    const before = withDesign(base, { ...readDesign(base), requirements: [{ id: 'internal-id', label: 'Verification command', description: '', value: '' }] });
    const after = withDesign(before, { ...readDesign(before), requirements: [{ id: 'internal-id', label: 'Verification command', description: '', value: 'bun run check' }] });
    expect(reviewDesignChanges(before, after).designDetails).toEqual([{ label: 'Verification command', before: '', after: 'bun run check' }]);
  });
  it('renames only the authored participant, not its incoming and outgoing neighbors', () => {
    const before = original();
    const review = reviewDesignChanges(before, edit(before, doc => { doc.definitions.find((item: { kind: string }) => item.kind === 'ControlFlow').annotations = { macroSteps: { review: { title: 'Final review' } } }; }));
    expect(review.changes.map(change => [change.kind, change.title])).toEqual([['modified', 'Final review']]);
    expect(review.other).toBe(false);
  });
  it('inserts a step without marking later paths modified', () => {
    const before = original();
    const review = reviewDesignChanges(before, edit(before, doc => { doc.graphs[0].steps.splice(1, 0, { ...doc.graphs[0].steps[0], id: 'extra' }); }));
    expect(review.changes.map(change => change.kind)).toEqual(['added']);
    expect(review.changes[0].path).toBe('/graphs/0/steps/1');
    expect(review.other).toBe(false);
  });
  it('reports invocation configuration alongside runtime changes', () => {
    const before = original();
    const review = reviewDesignChanges(before, edit(before, doc => { doc.graphs[0].steps[0].operation = 'inspect'; doc.runtime = { selected: 'another-config' }; }));
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0].aspects).toContain('configuration');
    expect(review.configuration).toBe(true);
    expect(review.other).toBe(false);
  });
  it('reports actual changed references without relying on their labels', () => {
    const before = original();
    const review = reviewDesignChanges(before, edit(before, doc => { doc.graphs[0].steps[2].bindings.brief.step = 'checklist'; }));
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0].aspects).toEqual(['connections']);
  });
  it('retains unmatched document changes alongside recognized edits', () => {
    const before = original();
    const review = reviewDesignChanges(before, edit(before, doc => { doc.graphs[0].steps[0].operation = 'inspect'; doc.graphs[0].entry = 'review'; }));
    expect(review.changes).toHaveLength(1);
    expect(review.other).toBe(true);
  });
  it('reports removal while remaining source positions shift', () => {
    const before = original();
    const review = reviewDesignChanges(before, edit(before, doc => { doc.graphs[0].steps.splice(1, 1); }));
    expect(review.changes).toHaveLength(1);
    expect(review.changes.some(change => change.kind === 'removed' && change.title === 'PR review')).toBe(true);
  });
  it('attributes instruction changes without a duplicate residual warning', () => {
    const before = original();
    const review = reviewDesignChanges(before, edit(before, doc => { doc.definitions.find((item: { kind: string }) => item.kind === 'Instructions').payload.body = 'Inspect the checklist carefully.'; }));
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0].aspects).toEqual(['instructions']);
    expect(review.other).toBe(false);
  });
  it('ignores serialization and object-key formatting changes', () => {
    const before = original();
    const review = reviewDesignChanges(before, JSON.stringify(JSON.parse(before)));
    expect(review).toEqual({ changes: [], configuration: false, design: false, other: false });
  });
});

describe('AgSDL 0.2 review', () => {
  it('attributes source prompt and flow changes to their authored participant', () => {
    const before = createExample020('release');
    const changed = edit(before, doc => { doc.agents.checklist.prompt[0].value = 'Check each prerequisite and cite evidence.'; doc.flow.steps.review.next = []; });
    const result = reviewDesignChanges(before, changed);
    expect(result.changes.map(change => [change.title, change.aspects])).toEqual([['checklist', ['instructions']], ['review', ['connections']]]);
    expect(result.other).toBe(false);
  });
  it('attributes composition instructions to the edited composition step', () => {
    const before = edit(createExample020('release'), doc => {
      doc.compositions = { audit: { agentParameters: [], entry: 'brief', outputs: ['done'], steps: { brief: { type: 'prepare', message: { prompt: [{ value: 'Check evidence.' }] }, next: [{ output: 'done' }] } } } };
    });
    const after = edit(before, doc => { doc.compositions.audit.steps.brief.message.prompt[0].value = 'Check evidence against the request.'; });
    const result = reviewDesignChanges(before, after);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].path).toBe('/compositions/audit/steps/brief');
    expect(result.changes[0].aspects).toEqual(['instructions']);
    expect(result.other).toBe(false);
  });
  it('compares design metadata even when the source has identical bytes', () => {
    const source = createExample020('release'), design = readDesign(source);
    const result = reviewDesignChanges(source, source, { design }, { design: { ...design, purpose: 'Check release evidence' } });
    expect(result.designDetails).toEqual([{ label: 'agsdl.design.purpose', before: '', after: 'Check release evidence' }]);
    expect(result.changes).toEqual([]);
    expect(result.other).toBe(false);
  });
});

describe('exact AgSDL 0.2 review ownership', () => {
  it('attributes shared prompt and skill edits to their consumers without a residual warning', () => {
    const before = edit(createExample020('release'), doc => {
      doc.content = { instruction: { value: 'BEFORE' } };
      doc.skills = { inspection: { prompt: [{ ref: 'instruction' }] } };
      doc.agents.checklist.prompt = [{ ref: 'instruction' }];
      doc.agents.review.skills = ['inspection'];
    });
    const after = applyChanges(before, [{ op: 'set', path: '/content/instruction/value', valueJson: '"AFTER"' }]);
    const result = reviewDesignChanges(before, after);
    expect(result.changes.map(change => [change.path, change.aspects])).toEqual([
      ['/agents/checklist', ['instructions']], ['/agents/review', ['instructions']],
    ]);
    expect(result.changes[0]).toMatchObject({ before: 'BEFORE', after: 'AFTER' });
    expect(result.changes[1].after).toStartWith('AFTER');
    expect(result.other).toBe(false);
    const changedSkill = edit(before, doc => { doc.skills.inspection.prompt = [{ value: 'New skill instruction.' }]; });
    expect(reviewDesignChanges(before, changedSkill).changes.map(change => change.path)).toEqual(['/agents/review']);
    expect(reviewDesignChanges(before, changedSkill).other).toBe(false);
  });
  it('keeps unused content changes visible and attributes shared prepared prompts', () => {
    const before = edit(createExample020('release'), doc => {
      doc.content = { instruction: { value: 'BEFORE' }, unused: { value: 'unused' } };
      doc.flow.steps.brief = { type: 'prepare', message: { prompt: [{ ref: 'instruction' }] } };
    });
    const after = applyChanges(before, [{ op: 'set', path: '/content/instruction/value', valueJson: '"AFTER"' }]);
    expect(reviewDesignChanges(before, after)).toMatchObject({ changes: [{ path: '/flow/steps/brief', aspects: ['instructions'], before: 'BEFORE', after: 'AFTER' }], other: false });
    const unused = applyChanges(before, [{ op: 'set', path: '/content/unused/value', valueJson: '"changed"' }]);
    expect(reviewDesignChanges(before, unused)).toMatchObject({ changes: [], other: true });
  });
  it('compares exact configuration integers, decimals and unowned values', () => {
    const before = edit(createExample020('release'), doc => { doc.configurations.project.settings = { budget: 0 }; doc.content = { unused: { value: 0 } }; });
    const numeric = (path: string, value: string) => applyChanges(before, [{ op: 'set', path, valueJson: value }]);
    expect(reviewDesignChanges(numeric('/configurations/project/settings/budget', '9007199254740992'), numeric('/configurations/project/settings/budget', '9007199254740993'))).toMatchObject({ configuration: true, other: false });
    expect(reviewDesignChanges(numeric('/configurations/project/settings/budget', '0.123456789012345678901'), numeric('/configurations/project/settings/budget', '0.123456789012345678902'))).toMatchObject({ configuration: true });
    expect(reviewDesignChanges(numeric('/configurations/project/settings/budget', '1e1000000'), numeric('/configurations/project/settings/budget', '10e999999'))).toEqual({ changes: [], configuration: false, design: false, other: false });
    expect(reviewDesignChanges(numeric('/content/unused/value', '9007199254740992'), numeric('/content/unused/value', '9007199254740993'))).toMatchObject({ other: true });
    expect(reviewDesignChanges(numeric('/configurations/project/settings/budget', '123'), numeric('/configurations/project/settings/budget', '{"raw":"123"}'))).toMatchObject({ configuration: true });
  });
  it('detects exact structured prompt changes as instructions', () => {
    const before = edit(createExample020('release'), doc => { doc.agents.checklist.prompt = [{ value: { limit: 0 } }]; });
    const first = applyChanges(before, [{ op: 'set', path: '/agents/checklist/prompt/0/value/limit', valueJson: '9007199254740992' }]);
    const second = applyChanges(first, [{ op: 'set', path: '/agents/checklist/prompt/0/value/limit', valueJson: '9007199254740993' }]);
    expect(reviewDesignChanges(first, second)).toMatchObject({ changes: [{ path: '/agents/checklist', aspects: ['instructions'] }], other: false });
  });
  it('keeps display changes for nonparticipant declarations visible', () => {
    const source = createExample020('release');
    for (const path of ['/configurations/project', '/content/instruction', '/bindings/engine']) {
      expect(reviewDesignChanges(source, source, { display: { cards: { [path]: { title: 'Before' } } } }, { display: { cards: { [path]: { title: 'After' } } } })).toMatchObject({ changes: [], other: true });
    }
    expect(reviewDesignChanges(source, source, { display: { cards: { '/agents/checklist': { title: 'Before' } } } }, { display: { cards: { '/agents/checklist': { title: 'After' } } } })).toMatchObject({ changes: [{ path: '/agents/checklist', aspects: ['identity'] }], other: false });
  });
});

it('retains an independent catalog edit when its last consumer is removed', () => {
  for (const skill of [false, true]) {
    const before = edit(createExample020('release'), doc => {
      doc.content = { shared: { value: 'BEFORE' } };
      if (skill) { doc.skills = { inspection: { prompt: [{ ref: 'shared' }] } }; doc.agents.checklist.skills = ['inspection']; doc.agents.checklist.prompt = []; }
      else doc.agents.checklist.prompt = [{ ref: 'shared' }];
    });
    const removed = edit(before, doc => { if (skill) delete doc.agents.checklist.skills; else delete doc.agents.checklist.prompt; });
    expect(reviewDesignChanges(before, removed).other).toBe(false);
    const changed = applyChanges(removed, [{ op: 'set', path: '/content/shared/value', valueJson: '"AFTER"' }]);
    expect(reviewDesignChanges(before, changed).other).toBe(true);
    const removedAgent = edit(before, doc => { delete doc.agents.checklist; });
    expect(reviewDesignChanges(before, removedAgent).other).toBe(false);
    expect(reviewDesignChanges(before, applyChanges(removedAgent, [{ op: 'set', path: '/content/shared/value', valueJson: '"AFTER"' }])).other).toBe(true);
  }
});
it('attributes prepared resources to connections without treating literal data as content references', () => {
  const before = edit(createExample020('release'), doc => {
    doc.content = { shared: { value: 'BEFORE' } };
    doc.agents.checklist.prompt = [{ ref: 'shared' }];
    doc.flow.steps.prepared = { type: 'prepare', message: { resources: {
      info: { ref: 'shared' }, literal: { select: { value: { ref: 'shared' } } },
    } } };
    doc.flow.steps.literal = { type: 'prepare', message: { resources: { literal: { select: { value: { ref: 'shared' } } } } } };
  });
  const after = applyChanges(before, [{ op: 'set', path: '/content/shared/value', valueJson: '"AFTER"' }]);
  expect(reviewDesignChanges(before, after)).toMatchObject({ changes: [
    { path: '/agents/checklist', aspects: ['instructions'] }, { path: '/flow/steps/prepared', aspects: ['connections'] },
  ], other: false });
});

it('removes instruction-only skills without reporting nonexistent resource connections', () => {
  const before = edit(createExample020('release'), doc => {
    doc.content = { shared: { value: 'BEFORE' } };
    doc.skills = { inspection: { prompt: [{ ref: 'shared' }] } };
    doc.agents.checklist.prompt = [];
    doc.agents.checklist.skills = ['inspection'];
  });
  const removedSelection = edit(before, doc => { delete doc.agents.checklist.skills; });
  expect(reviewDesignChanges(before, removedSelection)).toMatchObject({ changes: [{ path: '/agents/checklist', aspects: ['instructions', 'configuration'] }], other: false });
  const removedSkill = edit(removedSelection, doc => { delete doc.skills.inspection; });
  expect(reviewDesignChanges(before, removedSkill)).toMatchObject({ changes: [{ path: '/agents/checklist', aspects: ['instructions', 'configuration'] }], other: true });
});

it('keeps a legacy rename attributable even when an opaque number exceeds binary float range', () => {
  const before = edit(original(), doc => { doc.runtime.configurations[0].agents[0].parameters.opaque = 0; }).replace('"opaque":0', '"opaque":1e1000');
  const after = before.replace('"Checklist"', '"Final checklist"');
  expect(reviewDesignChanges(before, after)).toMatchObject({ changes: [{ title: 'Final checklist', aspects: ['identity'] }], other: false });
});
it('ignores object-key ordering while keeping distinct Unicode keys separate', () => {
  const before = edit(createExample020('release'), doc => { doc.configurations.project.settings = { 'é': 1, 'e\u0301': 2 }; });
  const reordered = edit(before, doc => { doc.configurations.project.settings = { 'e\u0301': 2, 'é': 1 }; });
  expect(reviewDesignChanges(before, reordered)).toEqual({ changes: [], configuration: false, design: false, other: false });
  const changed = edit(before, doc => { doc.configurations.project.settings['e\u0301'] = 3; });
  expect(reviewDesignChanges(before, changed).configuration).toBe(true);
});
