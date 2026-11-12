import { describe,expect,it } from 'bun:test';
import { applyChanges } from './document';
import { addAgent } from './editing';
import { createExample,createLegacyExample } from './examples';

describe('AgSDL editing by contract', () => {
  it('keeps sample agent declarations editable across repeated operations', () => {
    const source = createExample('release');
    const changes = addAgent(source);
    expect(changes.some(change => change.path.startsWith('/agents/'))).toBe(true);
    expect(() => applyChanges(source, changes)).not.toThrow();
    expect(addAgent(source)).toEqual(changes);
    expect(createExample('release')).toBe(source);
  });
  it('retains explicit 0.1 Agent authoring', () => {
    const source = createLegacyExample('release');
    const doc = JSON.parse(applyChanges(source, addAgent(source)));
    expect(doc.contract).toBe('agsdl-0.1.0');
    expect(doc.definitions.some((item: {kind: string; key: {id: string}}) => item.kind === 'Agent' && item.key.id === 'agent-1')).toBe(true);
  });
});
