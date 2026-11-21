import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { evaluateCompile030 } from './compile-oracle030';
function input() {
    const authored = '{"contract":"agsdl-0.3.0","id":"synthetic","agents":{"worker":{"harness":"synthetic","permissions":"read-only","maxCorrections":9007199254740993}}}';
    const evidence = '{"synthetic":true}';
    return { authored, source: { owner: { projectId: '\ud800', planId: 'synthetic', branch: 'feature/synthetic' }, revision: '1', sourceSha256: createHash('sha256').update(authored).digest('hex') }, registry: {
            format: 'macro-agsdl-registry/030', version: 'synthetic', modules: [], harnesses: [{ harness: 'synthetic', version: '1.0.0', installation: 'available', adapterId: 'synthetic-adapter', qualified: true, capabilities: ['result-submission', 'continuity', 'permission-enforcement', 'contained-stop', 'response-attribution', 'model.name', 'model.effort'].map(name => ({ name, support: 'native', evidenceJson: evidence })), models: [{ name: 'synthetic', efforts: ['medium'], defaultEffort: 'medium' }], defaultModel: 'synthetic' }], agents: [{ agentName: 'worker', agentDeclarationJson: '{"harness":"synthetic","permissions":"read-only","maxCorrections":9007199254740993}', settingsJson: '{}', permissionsJson: evidence, scopeJson: evidence, evidenceJson: evidence, provenanceJson: evidence }],
        } };
}
test('compilation oracle returns the complete raw output with both JSON domains', async () => {
    const result = JSON.parse(await evaluateCompile030({ op: 'host', json: JSON.stringify(input()) }));
    expect(result.status).toBe('ok');
    expect(result.json).toContain('\\ud800');
    const value = JSON.parse(result.json);
    expect(value.runtime.supported).toBe(true);
    expect(JSON.parse(value.plan.graphlessSubmissionContracts.worker).maxCorrections).toBe('9007199254740993');
    expect(value.compiledPlanJson).toContain('9007199254740993');
    expect(value.capturedRegistryJson).toBe(JSON.stringify(input().registry));
});
test('compilation captures source and observations before awaiting the digest', async () => {
    const original = input();
    const plain = await evaluateCompile030({ op: 'plan', json: JSON.stringify(original) });
    const mutated = await evaluateCompile030({ op: 'snapshot', json: JSON.stringify({ ...original, mutateSourceOwner: { projectId: 'changed' }, mutateAgent: { settingsJson: '{"changed":true}' } }) });
    expect(mutated).toBe(plain);
});
