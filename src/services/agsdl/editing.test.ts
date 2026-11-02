import { describe, expect, it } from 'bun:test';
import { addAgent, addDefinition, addStep, renameStep } from './editing';
import { applyChanges, validateDocument } from './document';
import { createExample, createLegacyExample } from './examples';
import { createEmptySystem } from './design';

describe('AgSDL editing by contract', () => {
  it('adds a complete persistent Agent and explicit engine binding to an empty 0.2 draft', async () => {
    const draft = createEmptySystem('Test');
    const source = applyChanges(draft, addAgent(draft, 0));
    const doc = JSON.parse(source);
    expect(Object.values(doc.agents)).toHaveLength(1);
    expect(doc.flow.steps['step-1'].type).toBe('agent');
    expect((await validateDocument(source)).flatMap(report => report.results).every(result => result.verdict === 'pass')).toBe(true);
  });
  it('renames flow map keys and every control reference while retaining opaque source numbers', () => {
    const doc = JSON.parse(createExample('release'));
    doc.bindings.engine.settings = { number: 0 };
    doc.flow.steps.review.onError = ['checklist'];
    doc.flow.steps['prepare-review'].next = ['checklist'];
    const source = JSON.stringify(doc).replace('"number":0', '"number":9007199254740993123');
    const updated = applyChanges(source, renameStep(source, 0, 0, 'inspect'));
    const next = JSON.parse(updated);
    expect(next.flow.entry).toBe('inspect');
    expect(next.flow.steps.inspect.agent).toBe('checklist');
    expect(next.flow.steps.checklist).toBeUndefined();
    expect(next.flow.steps.review.onError).toEqual(['inspect']);
    expect(next.flow.steps['prepare-review'].next).toEqual(['inspect']);
    expect(updated).toContain('"number":9007199254740993123');
    expect(() => renameStep(source, 0, 0, 'invalid name')).toThrow();
  });
  it('authors 0.2 content and skills without declaration annotations', async () => {
    let source = createEmptySystem('Test');
    for (const kind of ['Instructions', 'Resource', 'Skill', 'Tool']) source = applyChanges(source, addDefinition(source, kind));
    const doc = JSON.parse(source);
    expect(doc.content['instructions-1']).toEqual({ value: '' });
    expect(doc.skills['skill-1'].prompt).toHaveLength(1);
    expect(doc.definitions).toBeUndefined();
    expect((await validateDocument(source)).flatMap(report => report.results).every(result => result.verdict === 'pass')).toBe(true);
  });
  it('requires deliberate references for Join and Approval instead of invented protected calls', () => {
    const source = createExample('release');
    expect(() => addStep(source, 0, 'join')).toThrow('direct fork');
    expect(() => addStep(source, 0, 'approval')).toThrow('protected Call');
    expect(() => addStep(source, 0, 'end')).toThrow('empty next');
  });
  it('retains explicit 0.1 Agent authoring', () => {
    const source = createLegacyExample('release');
    const doc = JSON.parse(applyChanges(source, addAgent(source)));
    expect(doc.contract).toBe('agsdl-0.1.0');
    expect(doc.definitions.some((item: {kind: string; key: {id: string}}) => item.kind === 'Agent' && item.key.id === 'agent-1')).toBe(true);
  });
});
