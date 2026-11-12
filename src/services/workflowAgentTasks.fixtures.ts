/** Synthetic native 0.3 captures for Macro task integration tests. */
import { defaultDesign } from './agsdl/design';
import { createRunInspectionAccess030 } from './agsdl/runAccess030';
import { nativeAgentRunFixture030,nativeTransportFor030 } from './agsdl/runAccess030.testSupport';
import { sourceDigest } from './agsdlExecution/sourceDigest';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { WorkflowAgentTaskPorts } from './workflowAgentTasks';

export async function workflowTaskFixture() {
  const f = await nativeAgentRunFixture030('run', 'running');
  f.capture.source.owner = { projectId: 'project', planId: 'workflow', branch: 'develop' };
  const document = JSON.parse(f.capture.authoredSource);
  document.agents.reviewer = { harness: 'example', permissions: 'read-only' };
  f.capture.authoredSource = JSON.stringify(document);
  f.capture.source.sourceSha256 = await sourceDigest(f.capture.authoredSource);
  f.runtime.items.push({ kind: 'instance', value: { id: 'reviewer-instance', agent: 'reviewer', selectorKind: 'shared', selectorName: null,
    currentActivationId: null, queueActivationIds: [], discarded: false } });
  f.runtime.items.sort((a, b) => ({ instance: 0, activation: 1, group: 2, path: 3 }[a.kind] - { instance: 0, activation: 1, group: 2, path: 3 }[b.kind]) || a.value.id.localeCompare(b.value.id));
  f.runtime.total = String(f.runtime.items.length);
  const plan: ArchitectPlanRecord = { id: 'workflow', slug: 'workflow', title: 'Workflow synthétique', description: '', status: 'draft',
    targetBranch: 'develop', projectIds: ['project'], revision: 1, createdAt: '', updatedAt: '', nodes: [], predictedBranches: [],
    agsdl: { revision: 1, source: f.capture.authoredSource, annexes: {}, design: { ...defaultDesign(), origin: { branchName: 'develop', planId: 'blueprint', name: 'Blueprint', revision: 1 } } } };
  const calls: string[] = [];
  const ports: WorkflowAgentTaskPorts = {
    runs: async () => { calls.push('runs'); return { runs: [structuredClone(f.summary)], nextCursor: null }; },
    snapshot: async () => { calls.push('snapshot'); return structuredClone(f.capture); },
    inspect: async () => {
      calls.push('inspection');
      const { transport, scope } = nativeTransportFor030(f);
      const access = createRunInspectionAccess030(scope, transport);
      await access.refreshRun(f.capture.systemStartId);
      const run = access.getSnapshot().runs[f.capture.systemStartId];
      if (!run || run.kind !== 'ready') throw new Error('Synthetic native inspection failed');
      return run.value;
    },
  };
  return { plan, snapshot: f.capture, summary: f.summary, calls, ports, fixture: f };
}
