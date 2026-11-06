import { describe, expect, it } from 'bun:test';
import { applyChanges, validateDocument } from './document';
import { createEmptySystemDocument, readDesign } from './design';
import { AGSDL_EXAMPLES, createExample } from './examples';
import { authoringPatterns030 } from './examples030';
import { agsdlSessionKey, useAgsdlStore, type AgsdlSession } from '../../stores/useAgsdlStore';

/** Required after integrating the 0.3 reader. Kept executable, never skipped or mocked. */
describe('0.3 authoring with the production reader', () => {
  it('validates every shipped product template and complete guide example', async () => {
    const sources = [...AGSDL_EXAMPLES.map(kind => createExample(kind)), ...Object.values(authoringPatterns030()).map(doc => JSON.stringify(doc)), createEmptySystemDocument('Draft').source];
    for (const source of sources) {
      const reports = await validateDocument(source);
      expect(reports.every(report => report.scope !== 'unsupported-contract')).toBe(true);
      expect(reports.flatMap(report => report.results).every(result => result.verdict === 'pass')).toBe(true);
    }
  });
  it('patches a 0.3 source without rounding unrelated numbers or changing its edition', () => {
    const source = '{"contract":"agsdl-0.3.0","id":"draft","agents":{},"content":{"budget":{"value":9007199254740993123},"guide":{"value":"old"}}}';
    expect(applyChanges(source, [{ op: 'set', path: '/content/guide/value', valueJson: '"new"' }])).toBe(source.replace('"old"', '"new"'));
  });
  it('applies, undoes and redoes source adaptation with its envelope as one history operation', () => {
    const target = { branchName: 'feature/authoring-030', planId: 'adaptation' }, key = agsdlSessionKey(target);
    const source = createExample('feature');
    const design = { ...readDesign(source), requirements: [{ id: 'guidance', label: 'Guidance', description: '', value: '', targetPath: '/content/projectGuidance/value' }] };
    const session: AgsdlSession = { source, annexes: { note: 'unchanged' }, design, version: 'v1', persistedRevision: 1, status: 'draft', dirty: false, saving: false, history: [], future: [], reports: [], error: null };
    const previousSessions = useAgsdlStore.getState().sessions;
    useAgsdlStore.setState({ sessions: { [key]: session } });
    try {
      const store = useAgsdlStore.getState();
      store.setDesign(target, { ...design, requirements: [{ ...design.requirements[0], value: 'Run project checks.' }] }, 'v1');
      const updated = useAgsdlStore.getState().sessions[key];
      expect(JSON.parse(updated.source).content.projectGuidance.value).toBe('Run project checks.');
      expect(updated.history).toHaveLength(1);
      store.undo(target);
      expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
      expect(useAgsdlStore.getState().sessions[key].design?.requirements[0].value).toBe('');
      store.undo(target, true);
      expect(useAgsdlStore.getState().sessions[key].source).toBe(updated.source);
      expect(useAgsdlStore.getState().sessions[key].annexes).toEqual({ note: 'unchanged' });
    } finally { useAgsdlStore.setState({ sessions: previousSessions }); }
  });
});
