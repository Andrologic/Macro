import { createArchitectPlan, getArchitectPlan, type ArchitectPlanRecord } from './architectPlanService';
import * as ipc from './ipc/agsdlExecution';
import { getConversation } from './ipc/conversations';
import { AGSDL_CONTRACT, readDocument } from './agsdl/document';
import { readDesign, withDocumentDesign } from './agsdl/design';
import { assertProjection, executionInput, executionPrompt } from './agsdl/executionView';
import { sameSource } from './agsdl/runtimeSelection';
import { sourceDigest } from './agsdlExecution/compiler';
import { sanitizeId } from './architectPlanReadModel';
import type { ExecutionPreflight } from '../types/generated/ipc';
import type {
  DeliveryId, IntentId, ExecutionIntentKey, ExecutionIntentScope, PublicExecutionIntent,
  PublicProjection, PublicSnapshot, SourceRevision,
} from './agsdlExecution/contracts';

export interface BlueprintReference {
  branchName: string;
  planId: string;
  /** Canonical plan revision, including its design and display metadata. */
  revision: number;
}
export interface BlueprintWorkflowRequest {
  blueprint: BlueprintReference;
  /** Allocate once and retain across retries. The conversation must already
   * belong to the selected project; no selected UI state is consulted. */
  scope: ExecutionIntentScope;
  prompt?: string;
}
export interface BlueprintWorkflowResult {
  plan: ArchitectPlanRecord;
  intent: PublicExecutionIntent;
  snapshot?: PublicSnapshot;
  projection?: PublicProjection;
}
export type BlueprintWorkflowErrorCode = 'BLUEPRINT_UNAVAILABLE' | 'SOURCE_CHANGED' | 'SCOPE_INVALID' |
  'IDENTITY_CONFLICT' | 'INPUT_REQUIRED' | 'INPUT_NOT_APPLICABLE' | 'RUNTIME_UNAVAILABLE' | 'RECEIPT_INVALID';
export class BlueprintWorkflowError extends Error {
  constructor(readonly code: BlueprintWorkflowErrorCode, readonly preflight?: ExecutionPreflight) {
    super(code);
    this.name = 'BlueprintWorkflowError';
  }
}
export interface BlueprintWorkflowPorts {
  getPlan: typeof getArchitectPlan;
  createPlan: typeof createArchitectPlan;
  getConversation: typeof getConversation;
  preflight: typeof ipc.preflightExecution;
  readIntent: typeof ipc.readExecutionIntent;
  stage: typeof ipc.stageExecutionIntent;
  submit: typeof ipc.submitExecutionIntent;
  close: typeof ipc.closeExecutionIntent;
  snapshot: typeof ipc.readExecutionSnapshot;
  projection: typeof ipc.readExecutionProjection;
}
const defaults: BlueprintWorkflowPorts = {
  getPlan: getArchitectPlan, createPlan: createArchitectPlan, getConversation,
  preflight: ipc.preflightExecution, readIntent: ipc.readExecutionIntent,
  stage: ipc.stageExecutionIntent, submit: ipc.submitExecutionIntent, close: ipc.closeExecutionIntent,
  snapshot: ipc.readExecutionSnapshot, projection: ipc.readExecutionProjection,
};
function fail(code: BlueprintWorkflowErrorCode): never { throw new BlueprintWorkflowError(code); }
const sameOwner = (a: ExecutionIntentScope['owner'], b: ExecutionIntentScope['owner']) =>
  a.projectId === b.projectId && a.planId === b.planId && a.branch === b.branch;
const sameScope = (a: ExecutionIntentScope, b: ExecutionIntentScope) =>
  sameOwner(a.owner, b.owner) && a.conversationId === b.conversationId;
const keyOf = (scope: ExecutionIntentScope): ExecutionIntentKey => ({ scope, intentId: `blueprint-start:${scope.owner.planId}` as IntentId });

function validateScope(scope: ExecutionIntentScope): void {
  const { owner } = scope;
  if (![owner.projectId, owner.planId, owner.branch, scope.conversationId].every(value =>
    typeof value === 'string' && value.length > 0 && value.length <= 400 && value.trim() === value && !/\p{Cc}/u.test(value)) ||
    owner.planId !== sanitizeId(owner.planId) || ['.', '..'].includes(owner.planId) || owner.branch.includes('\\') ||
    owner.branch.split('/').some(part => !part || part === '.' || part === '..')) fail('SCOPE_INVALID');
}
function assertPlanScope(plan: ArchitectPlanRecord, scope: ExecutionIntentScope): void {
  const projects = plan.projectIds ?? (plan.projectId ? [plan.projectId] : []);
  if (plan.id !== scope.owner.planId || plan.targetBranch !== scope.owner.branch ||
    projects.length !== 1 || projects[0] !== scope.owner.projectId || plan.conversationId !== scope.conversationId ||
    plan.status === 'deleted' || plan.status === 'archived' || plan.hasReplicaDivergence || plan.missingProjectIds?.length ||
    !plan.agsdl) fail('SCOPE_INVALID');
}
function assertOrigin(plan: ArchitectPlanRecord, ref: BlueprintReference): void {
  const design = readDesign(plan.agsdl!.source, plan.agsdl!.design);
  if (design.kind !== 'system' || design.origin?.planId !== ref.planId ||
    design.origin.branchName !== ref.branchName || design.origin.revision !== ref.revision) fail('IDENTITY_CONFLICT');
}

/** Headless production entry point. Metadata copies and native intents are the
 * durable state; there is no simulated scheduler or additional workflow store. */
export function createBlueprintWorkflowService(overrides: Partial<BlueprintWorkflowPorts> = {}) {
  const ports = { ...defaults, ...overrides };
  async function scopedPlan(scope: ExecutionIntentScope): Promise<ArchitectPlanRecord | null> {
    validateScope(scope);
    const conversation = await ports.getConversation(scope.conversationId);
    if (!conversation || conversation.project_id !== scope.owner.projectId) fail('SCOPE_INVALID');
    const plan = await ports.getPlan(scope.owner.branch, scope.owner.planId);
    if (plan) assertPlanScope(plan, scope);
    return plan;
  }

  async function prepare(input: BlueprintWorkflowRequest): Promise<ArchitectPlanRecord> {
    // Own all mutable arguments before the first await, including the scope used
    // later by native admission. A UI selection change cannot redirect this run.
    const request = structuredClone(input);
    const { scope, blueprint } = request;
    validateScope({ ...scope, owner: { ...scope.owner, planId: blueprint.planId, branch: blueprint.branchName } });
    if (!Number.isSafeInteger(blueprint.revision) || blueprint.revision < 1 ||
      (scope.owner.planId === blueprint.planId && scope.owner.branch === blueprint.branchName)) fail('IDENTITY_CONFLICT');
    const retained = await scopedPlan(scope);
    if (retained) { assertOrigin(retained, blueprint); return retained; }

    const original = await ports.getPlan(blueprint.branchName, blueprint.planId);
    if (!original?.agsdl || original.status === 'deleted' || original.status === 'archived' ||
      original.hasReplicaDivergence || original.missingProjectIds?.length) fail('BLUEPRINT_UNAVAILABLE');
    if (original.revision !== blueprint.revision) fail('SOURCE_CHANGED');
    const document = structuredClone(original.agsdl);
    const design = readDesign(document.source, document.design);
    const projects = original.projectIds ?? (original.projectId ? [original.projectId] : []);
    if (design.kind !== 'blueprint' || (projects.length && !projects.includes(scope.owner.projectId)) ||
      readDocument(document.source).contract !== AGSDL_CONTRACT) fail('BLUEPRINT_UNAVAILABLE');
    const copy = withDocumentDesign(document.source, { ...design, kind: 'system', origin: {
      planId: blueprint.planId, branchName: blueprint.branchName, revision: blueprint.revision,
      name: original.label || original.title,
    } }, document);
    // Reusable presentation is safe to copy; historical Task identities and
    // statuses belong to the old run, never to this project's new execution.
    if (copy.display?.cards) for (const card of Object.values(copy.display.cards)) {
      delete card.macroTaskId; delete card.macroLegacyNodeId; delete card.macroStatus;
    }
    try {
      const plan = await ports.createPlan({ branchName: scope.owner.branch, planId: scope.owner.planId,
        label: original.label || original.title, description: design.purpose, projectIds: [scope.owner.projectId],
        contextProjectIds: [], conversationId: scope.conversationId, status: 'draft', setActive: false,
        agsdl: { ...copy, annexes: document.annexes } });
      assertPlanScope(plan, scope); assertOrigin(plan, blueprint);
      return plan;
    } catch (error) {
      // A metadata commit may succeed even when its acknowledgement is lost, or
      // another caller may have won the same creation. Recover only this identity.
      const plan = await scopedPlan(scope);
      if (!plan) throw error;
      assertOrigin(plan, blueprint);
      return plan;
    }
  }

  function assertIntent(intent: PublicExecutionIntent, key: ExecutionIntentKey): void {
    if (!sameScope(intent.key.scope, key.scope) || intent.key.intentId !== key.intentId ||
      intent.payload.kind !== 'start' || !sameOwner(intent.payload.request.source.owner, key.scope.owner) ||
      intent.payload.request.requestId !== key.intentId) fail('RECEIPT_INVALID');
  }

  async function settle(plan: ArchitectPlanRecord, initial: PublicExecutionIntent): Promise<BlueprintWorkflowResult> {
    const key = keyOf(initial.key.scope);
    assertIntent(initial, key);
    let intent = initial;
    if (intent.state.kind === 'prepared' || intent.state.kind === 'submissionPending') {
      intent = await ports.submit(key);
      assertIntent(intent, key);
      // Submission must retain the exact request already persisted by native code.
      if (JSON.stringify(intent.payload) !== JSON.stringify(initial.payload)) fail('RECEIPT_INVALID');
    }
    const admission = intent.state.kind === 'admitted' || intent.state.kind === 'closed' ? intent.state.admission : null;
    if (!admission) return { plan, intent };
    if (admission.kind !== 'start' || intent.payload.kind !== 'start') fail('RECEIPT_INVALID');
    const { receipt } = admission;
    const snapshot = await ports.snapshot(receipt.systemStartId);
    if (snapshot.systemStartId !== receipt.systemStartId || receipt.snapshot.systemStartId !== receipt.systemStartId ||
      !sameSource(snapshot.source, intent.payload.request.source) || !sameSource(receipt.snapshot.source, snapshot.source) ||
      snapshot.authoredSource !== receipt.snapshot.authoredSource ||
      await sourceDigest(snapshot.authoredSource) !== snapshot.source.sourceSha256) fail('RECEIPT_INVALID');
    const projection = await ports.projection(snapshot.systemStartId);
    assertProjection(projection, snapshot);
    if (intent.state.kind === 'admitted') {
      let closed: PublicExecutionIntent;
      try {
        closed = await ports.close({ key, expectedRevision: intent.revision, disposition: 'acknowledged' });
      } catch (error) {
        if ((error as { code?: string })?.code !== 'SUBMISSION_IN_PROGRESS') throw error;
        // Another client may still own Close. Its admitted row is already a
        // successful Start; leave the acknowledgement recoverable on contention.
        const retained = await ports.readIntent(key);
        if (!retained) fail('RECEIPT_INVALID');
        assertIntent(retained, key);
        if (JSON.stringify(retained.payload) !== JSON.stringify(intent.payload) ||
          (retained.state.kind !== 'admitted' && retained.state.kind !== 'closed') ||
          JSON.stringify(retained.state.admission) !== JSON.stringify(admission)) fail('RECEIPT_INVALID');
        return { plan, intent: retained, snapshot, projection };
      }
      assertIntent(closed, key);
      if (closed.state.kind !== 'closed' || closed.state.disposition !== 'acknowledged' ||
        JSON.stringify(closed.payload) !== JSON.stringify(intent.payload) ||
        JSON.stringify(closed.state.admission) !== JSON.stringify(admission)) fail('RECEIPT_INVALID');
      intent = closed;
    }
    return { plan, intent, snapshot, projection };
  }

  async function launch(input: BlueprintWorkflowRequest): Promise<BlueprintWorkflowResult> {
    const request = structuredClone(input);
    const plan = await prepare(request);
    const key = keyOf(request.scope);
    const retained = await ports.readIntent(key);
    if (retained) {
      assertIntent(retained, key);
      if (request.prompt !== undefined && retained.payload.kind === 'start' &&
        (!retained.payload.request.entry || retained.payload.request.entry.messageJson !== executionPrompt(request.prompt))) fail('IDENTITY_CONFLICT');
      return settle(plan, retained);
    }
    if (!Number.isSafeInteger(plan.revision) || plan.revision! < 1) fail('SOURCE_CHANGED');
    const expected: SourceRevision = { owner: request.scope.owner, revision: String(plan.revision),
      sourceSha256: await sourceDigest(plan.agsdl!.source) as SourceRevision['sourceSha256'] };
    const preflight = await ports.preflight({ owner: request.scope.owner, expected });
    if (!sameSource(preflight.source as SourceRevision, expected) || preflight.authoredSource !== plan.agsdl!.source) fail('SOURCE_CHANGED');
    if (!preflight.productRuntimeAvailable || !preflight.staticValid || !preflight.runtimeSupported || preflight.incomplete) {
      throw new BlueprintWorkflowError('RUNTIME_UNAVAILABLE', preflight);
    }
    const { hasEntry } = executionInput(preflight.authoredSource);
    if (hasEntry && !request.prompt?.trim()) fail('INPUT_REQUIRED');
    if (!hasEntry && request.prompt !== undefined) fail('INPUT_NOT_APPLICABLE');
    const staged = await ports.stage({ ...key, payload: { kind: 'start', request: {
      source: expected, profile: 'macro-serial-inline-v1', associations: {}, requestId: key.intentId,
      entry: hasEntry ? { deliveryId: `${key.intentId}:entry` as DeliveryId, messageJson: executionPrompt(request.prompt!) } : null,
    } } });
    assertIntent(staged, key);
    return settle(plan, staged);
  }

  async function resume(input: ExecutionIntentScope): Promise<BlueprintWorkflowResult> {
    const scope = structuredClone(input);
    const plan = await scopedPlan(scope);
    if (!plan || plan.agsdl?.design?.kind !== 'system' || !plan.agsdl.design.origin?.branchName) fail('SCOPE_INVALID');
    const intent = await ports.readIntent(keyOf(scope));
    if (!intent) fail('IDENTITY_CONFLICT');
    assertIntent(intent, keyOf(scope));
    return settle(plan, intent);
  }
  return { prepare, launch, resume };
}

export const blueprintWorkflowService = createBlueprintWorkflowService();
