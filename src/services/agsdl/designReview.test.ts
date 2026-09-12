import { describe, expect, it } from 'bun:test';
import { createExample } from './examples';
import { reviewDesignChanges } from './designReview';
const original = () => createExample('release');
const edit = (source: string, change: (doc: ReturnType<typeof JSON.parse>) => void) => { const doc = JSON.parse(source); change(doc); return JSON.stringify(doc); };
describe('authored design changes', () => {
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
