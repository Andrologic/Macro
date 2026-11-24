import { describe,expect,it } from 'bun:test';
import { createEmptySystemDocument,readDesign,withDocumentDesign } from './design';
import { reviewDesignChanges } from './designReview';
import { AGSDL_EXAMPLES,createExample,createExampleDocument } from './examples';
import { authoringPatterns030 } from './examples030';

const changed = (source: string, edit: (doc: ReturnType<typeof JSON.parse>) => void) => {
  const doc = JSON.parse(source); edit(doc); return JSON.stringify(doc);
};

describe('0.4 authoring defaults and historical editions', () => {
  it('creates a minimal graphless draft with a source title and explicit blueprint kind', () => {
    const draft = createEmptySystemDocument('Préparer la livraison', 'agsdl-0.3.0', 'blueprint');
    expect(JSON.parse(draft.source)).toEqual({ contract: 'agsdl-0.3.0', id: expect.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), title: 'Préparer la livraison', agents: {} });
    expect(draft.design?.kind).toBe('blueprint');
    expect(JSON.parse(createEmptySystemDocument('Default').source).contract).toBe('agsdl-0.4.0');
  });
  it('retains exact source, annexes, provenance and opaque metadata during metadata-only edits', () => {
    for (const contract of ['agsdl-0.3.0'] as const) {
      const draft = createEmptySystemDocument('Copy', contract);
      const source = draft.source.replace('"agents": {}', '"agents" : {}');
      const origin = { planId: 'template', name: 'Template', revision: 3 };
      const design = { ...draft.design!, origin, opaque: { future: true } };
      const next = withDocumentDesign(source, { ...readDesign(source, design), purpose: 'Vérifier' }, { ...draft, design });
      expect(next.source).toBe(source);
      expect(next.design).toMatchObject({ purpose: 'Vérifier', origin, opaque: { future: true } });
    }
  });
  it('keeps four historical template identities and provides complete missions with fresh review', () => {
    expect(AGSDL_EXAMPLES).toEqual(['release', 'feature', 'hotfix', 'bugfix']);
    for (const kind of AGSDL_EXAMPLES) {
      const doc = JSON.parse(createExample(kind));
      expect(doc.contract).toBe('agsdl-0.4.0');
      expect(doc.bindings).toBeUndefined(); expect(doc.configurations).toBeUndefined();
      expect(doc.agents.implement.instructions).toContainEqual({ ref: 'projectGuidance' });
      expect(doc.agents.implement.model).toBeUndefined();
      expect(doc.agents.review).toMatchObject({ harness: 'claude-code', permissions: 'read-only' });
      expect(doc.flow.steps.review.instance).toBe('new');
      expect(doc.flow.steps.implement.next.message.resources.report.from).toEqual(['results', 'report']);
      for (const contract of ['agsdl-0.1.0'] as const) expect(JSON.parse(createExample(kind, contract)).contract).toBe(contract);
      expect(createExampleDocument(kind).display?.cards?.['/agents/review']).toMatchObject({ title: 'Independent review' });
    }
    expect(Object.keys(authoringPatterns030())).toEqual(['assistant', 'instructs', 'fanout', 'quorum', 'composition', 'approval']);
  });
});

describe('0.3 change attribution', () => {
  const source = () => createExample('feature');
  it('attributes referenced instructions to their owning agent and ignores formatting', () => {
    const before = source();
    const after = changed(before, doc => { doc.content.projectGuidance.value = 'Check the project-specific commands.'; });
    const review = reviewDesignChanges(before, after);
    expect(review.changes).toMatchObject([{ path: '/agents/implement', aspects: ['instructions'] }]);
    expect(review.other).toBe(false);
    expect(reviewDesignChanges(before, JSON.stringify(JSON.parse(before)))).toEqual({ changes: [], configuration: false, design: false, other: false });
  });
  it('attributes model, permissions, checks, plans and MCP equipment without encoding provider names', () => {
    for (const [key, value] of Object.entries({ model: { name: 'local/open-model', effort: 'custom' }, permissions: 'read-only', completionCheck: { command: 'project-check' }, planFirst: 'auto', mcpServers: ['docs'] })) {
      const before = source();
      const after = changed(before, doc => { doc.agents.implement[key] = value; });
      expect(reviewDesignChanges(before, after).changes).toMatchObject([{ path: '/agents/implement', aspects: ['configuration'] }]);
      expect(reviewDesignChanges(before, after).configuration).toBe(true);
    }
    const before = changed(source(), doc => { doc.mcpServers = { docs: { url: 'https://docs.example.test/mcp' } }; doc.agents.review.mcpServers = ['docs']; });
    const after = changed(before, doc => { doc.mcpServers.docs.url = 'https://other.example.test/mcp'; });
    expect(reviewDesignChanges(before, after)).toMatchObject({ changes: [{ path: '/agents/review', aspects: ['configuration'] }], other: false });
  });
  it('attributes route messages, choices and flow handlers without marking a neighbor changed', () => {
    const before = source();
    const route = changed(before, doc => { doc.flow.steps.review.next.revise.message.prompt = 'Address only the blocking findings.'; });
    expect(reviewDesignChanges(before, route)).toMatchObject({ changes: [{ path: '/flow/steps/review', aspects: ['connections'] }], other: false });
    const handler = changed(before, doc => { doc.flow.onError = 'review'; });
    expect(reviewDesignChanges(before, handler)).toMatchObject({ changes: [{ path: '/flow', aspects: ['connections'] }], other: false });
  });
  it('keeps composition pointers stable and distinguishes large numbers exactly', () => {
    const before = JSON.stringify(authoringPatterns030().composition);
    const after = changed(before, doc => { doc.compositions.review.steps.inspect.prompt = 'Inspect the changed behavior.'; });
    expect(reviewDesignChanges(before, after).changes).toMatchObject([{ path: '/compositions/review/steps/inspect', aspects: ['instructions'] }]);
    const large = changed(source(), doc => { doc.agents.implement.harnessSettings = { budget: 0 }; }).replace('"budget":0', '"budget":9007199254740993123');
    const adjacent = large.replace('9007199254740993123', '9007199254740993124');
    expect(reviewDesignChanges(large, adjacent).changes).toMatchObject([{ path: '/agents/implement', aspects: ['configuration'] }]);
    expect(reviewDesignChanges(large, large.replace('9007199254740993123', '90071992547409931230e-1'))).toEqual({ changes: [], configuration: false, design: false, other: false });
  });
});

it.each(['/agents/review', '/flow/steps/review'])('reviews display descriptions at %s with or without authored instructions', path => {
  for (const populated of [false, true]) {
    const source = changed(createExample('feature'), doc => {
      if (populated) doc.flow.steps.review.prompt = 'Inspect this candidate.';
      else { delete doc.agents.review.instructions; delete doc.flow.steps.review.prompt; }
    });
    const metadata = (description: string) => ({ display: { cards: { [path]: { description } } } });
    const review = reviewDesignChanges(source, source, metadata('First description'), metadata('Changed description'));
    expect(review.changes).toMatchObject([{ path, aspects: ['instructions'] }]);
    expect(review.changes[0].details).toMatchObject([{ aspect: 'instructions', before: expect.stringContaining('First description'), after: expect.stringContaining('Changed description') }]);
    expect(review.configuration).toBe(false);
    expect(review.other).toBe(false);
    expect(reviewDesignChanges(source, source, metadata('Unchanged'), metadata('Unchanged'))).toEqual({ changes: [], configuration: false, design: false, other: false });
  }
});

it('ignores equivalent numeric spellings in routes and still reports changed limits exactly', () => {
  const source = JSON.stringify(authoringPatterns030().fanout);
  for (const [before, after] of [['"max":100', '"max":1e2'], ['"concurrency":2', '"concurrency":2.0']] as const) {
    expect(source).toContain(before);
    expect(reviewDesignChanges(source, source.replace(before, after))).toEqual({ changes: [], configuration: false, design: false, other: false });
  }
  expect(reviewDesignChanges(source, source.replace('"max":100', '"max":101'))).toMatchObject({ changes: [{ path: '/flow/steps/files', aspects: ['connections'] }], other: false });
  const large = source.replace('"max":100', '"max":9007199254740993123');
  expect(reviewDesignChanges(large, large.replace('9007199254740993123', '90071992547409931230e-1'))).toEqual({ changes: [], configuration: false, design: false, other: false });
  expect(reviewDesignChanges(large, large.replace('9007199254740993123', '9007199254740993124')).changes).toMatchObject([{ path: '/flow/steps/files', aspects: ['connections'] }]);
});
