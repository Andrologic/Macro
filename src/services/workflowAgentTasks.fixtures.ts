/** Synthetic captures for workflow projection tests. No provider is contacted. */
import type { ArchitectPlanRecord } from './architectPlanService';
import type { PublicActivation, PublicProjection, PublicSnapshot } from './agsdlExecution/contracts';
import type { PublicApproval, PublicRunSummary } from '../types/generated/ipc';
import type { WorkflowAgentTaskPorts } from './workflowAgentTasks';
import { sourceDigest } from './agsdlExecution/compiler';
import { documentFixture, id } from './agsdlExecution/conformanceFixtures';
import { clone, encode, record } from './agsdlExecution/exact';
import { defaultDesign } from './agsdl/design';
type Mutable<T> = T extends string | number | boolean | null ? T : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

export async function workflowTaskFixture() {
  const doc = documentFixture();
  record(doc.agents).reviewer = clone(record(doc.agents).worker);
  const source = encode(doc);
  const plan: ArchitectPlanRecord = { id: 'workflow', slug: 'workflow', title: 'Workflow synthétique',
    description: '', status: 'draft', targetBranch: 'develop', projectIds: ['project'], revision: 1,
    createdAt: '', updatedAt: '', nodes: [], predictedBranches: [], agsdl: { revision: 1, source, annexes: {},
      design: { ...defaultDesign(), origin: { branchName: 'develop', planId: 'blueprint', name: 'Blueprint', revision: 1 } } } };
  const snapshot: PublicSnapshot = { systemStartId: id('run'), source: {
    owner: { projectId: 'project', planId: plan.id, branch: plan.targetBranch }, revision: '1', sourceSha256: id(await sourceDigest(source)),
  }, authoredSource: source, associations: {}, versions: { snapshot: '1', contract: 'agsdl-0.2.0', compiler: 'compiler', runtime: 'runtime',
    registry: 'registry', profile: 'macro-serial-inline-v1' } };
  const activation = (position: string, state: PublicActivation['workState'] = 'active',
    terminal: PublicActivation['terminalKind'] = null, agent = 'worker'): Mutable<PublicActivation> => ({
    work: { systemStartId: snapshot.systemStartId, flowInvocationId: id('flow'), activationId: id(`activation-${position}`),
      step: ['work'], agentInstanceId: id(`instance-${agent}`) }, deliveryId: id(`delivery-${position}`), queueSequence: id(position),
    workState: state, stopState: { kind: 'none' }, terminalKind: terminal,
  });
  const projection: Mutable<PublicProjection> = { systemStartId: snapshot.systemStartId, source: structuredClone(snapshot.source), cursor: id('10'),
    agents: [{ agentName: 'worker', agentInstanceId: id('instance-worker') }, { agentName: 'reviewer', agentInstanceId: id('instance-reviewer') }],
    activations: [activation('1')], nextPage: null, systemStop: { kind: 'none' } };
  const approvals: PublicApproval[] = [];
  const summary: PublicRunSummary = { systemStartId: snapshot.systemStartId, flowInvocationId: 'flow', source: snapshot.source,
    versions: snapshot.versions, cursor: projection.cursor, systemStop: projection.systemStop,
    counts: { queued: '0', active: '1', completed: '0', failed: '0', stopped: '0', uncertain: '0' } };
  const calls: string[] = [];
  const ports: WorkflowAgentTaskPorts = {
    runs: async () => { calls.push('runs'); return { runs: [structuredClone(summary)], nextCursor: null }; },
    snapshot: async () => { calls.push('snapshot'); return structuredClone(snapshot); },
    projection: async () => { calls.push('projection'); return structuredClone(projection); },
    approvals: async () => { calls.push('approvals'); return { approvals: structuredClone(approvals), incomplete: false }; },
  };
  return { plan, snapshot, projection, activation, approvals, summary, calls, ports };
}
