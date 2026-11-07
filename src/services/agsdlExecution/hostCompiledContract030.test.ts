import { expect, it } from 'bun:test';
import { NumberToken, parse } from '../../vendor/agsdl/v0.3/json.mjs';
import { validate } from '../../vendor/agsdl/v0.3/valueschema.mjs';
import type { EngineContext } from '../../types/generated/ipc/EngineContext';
import type { ExactJsonText, SourceRevision } from './contracts';
import type { CapturedRegistry030 } from './contracts030';
import { sourceDigest } from './compiler';
import { compilePlan030 } from './compiler030';
import { connectValueSchemaValidator030 } from './valueSchemaPort030';
import { EMPTY_WORK_JOURNAL030 } from './hostWorkJournal030';
import { evaluateHostWork030 } from './hostWorkTransition030';

it('evaluates the actual compiled graphless work contract with the shipped value reader', async () => {
  const agentJson = '{"harness":"synthetic","permissions":"read-only","results":{"data":{"required":true,"schema":{"type":"integer"}}}}' as ExactJsonText;
  const authored = `{"contract":"agsdl-0.3.0","id":"interop","agents":{"worker":${agentJson}}}`;
  const source: SourceRevision = { owner: { projectId: 'project', planId: 'plan', branch: 'feature/test' }, revision: '1', sourceSha256: await sourceDigest(authored) as SourceRevision['sourceSha256'] };
  const evidence = '{"fixture":true}' as ExactJsonText;
  const registry: CapturedRegistry030 = { format: 'macro-agsdl-registry/030', version: 'capture', modules: [],
    harnesses: [{ harness: 'synthetic', version: '1.0.0', installation: 'available', adapterId: 'fixture', qualified: true,
      defaultModel: 'model', models: [{ name: 'model', efforts: [], defaultEffort: null }],
      capabilities: ['result-submission', 'agent-continuity', 'continuity', 'permission-enforcement', 'contained-stop', 'response-attribution'].map(name => ({ name, support: 'native', evidenceJson: evidence })) }],
    agents: [{ agentName: 'worker', agentDeclarationJson: agentJson, settingsJson: '{}' as ExactJsonText,
      permissionsJson: '{"preset":"read-only"}' as ExactJsonText, scopeJson: '{"workspace":"/synthetic/workspace"}' as ExactJsonText,
      evidenceJson: evidence, provenanceJson: '{"documentBase":"file:///synthetic/workspace/flow.json","entries":[]}' as ExactJsonText }] };
  const compilation = await compilePlan030(authored, source, registry);
  expect(compilation.runtime.diagnostics).toEqual([]);
  const contract = compilation.plan?.graphlessSubmissionContracts.worker;
  expect(contract).toBeDefined();
  const context: EngineContext = { owner: { systemStartId: 'run', ownerEpoch: '1' },
    work: { systemStartId: 'run', flowInvocationId: 'flow', activationId: 'work', step: null, agentInstanceId: 'instance' },
    permissionsJson: '{}', scopeJson: '{}', registryVersion: 'capture' };
  const owner = { systemStartId: 'run', activationId: 'work', agentInstanceId: 'instance', ownerEpoch: '1' };
  const input = JSON.stringify({ owner, eventId: 'submit', event: { kind: 'submit', callId: 'call', argumentsJson: '{"results":{"data":9007199254740993}}' } });
  const result = evaluateHostWork030(context, 'submit', '0', contract!, EMPTY_WORK_JOURNAL030, input,
    '{"checkTimeoutMs":"1000","maxCheckOutputBytes":1024,"enforcedPlanLock":false}', connectValueSchemaValidator030({ NumberToken, parse, validate }));
  expect(JSON.parse(result.receiptJson).decision.output.resultsJson).toBe('{"data":9007199254740993}');
  expect(compilation.productRuntimeAvailable).toBe(false);
});
