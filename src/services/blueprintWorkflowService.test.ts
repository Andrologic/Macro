import { describe, expect, it } from 'bun:test';
import { createBlueprintWorkflowService, type BlueprintWorkflowPorts, type BlueprintWorkflowRequest } from './blueprintWorkflowService';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { PublicExecutionIntent, PublicProjection, PublicSnapshot, SourceRevision } from './agsdlExecution/contracts';
import { compilePlan, sourceDigest } from './agsdlExecution/compiler';
import { documentFixture, id, registryFixture } from './agsdlExecution/conformanceFixtures';
import { encode, record } from './agsdlExecution/exact';
import { defaultDesign } from './agsdl/design';
import type { DbConversation } from './tauriIpc';

/** The real compiler checks capability/configuration and exact source here.
 * Native transport is controlled IO; SQLite admission is tested in Rust. */
async function harness(shared = false) {
  const document = documentFixture();
  const blueprint: ArchitectPlanRecord = { id: 'template', slug: 'template', title: 'Synthetic workflow',
    label: 'Vérifier le projet', description: '', targetBranch: 'develop', status: 'draft', revision: 4,
    projectIds: shared ? [] : ['project'], createdAt: '', updatedAt: '', nodes: [], predictedBranches: [],
    agsdl: { source: encode(document), revision: 2, annexes: { guidance: 'Instructions synthétiques.' },
      design: { ...defaultDesign(), kind: 'blueprint' }, display: { cards: { '/flow/steps/work': {
        title: 'Vérifier', macroTaskId: 'old-task', macroLegacyNodeId: 'old-node', macroStatus: 'completed',
      } } } } };
  const plans = new Map([[JSON.stringify(['develop', 'template']), structuredClone(blueprint)]]);
  const request: BlueprintWorkflowRequest = { blueprint: { branchName: 'develop', planId: 'template', revision: 4 },
    scope: { owner: { projectId: 'project', planId: 'workflow-one', branch: 'develop' }, conversationId: 'workflow-chat' },
    prompt: 'Vérifie ce projet synthétique.' };
  const calls: string[] = [];
  let intent: PublicExecutionIntent | null = null;
  let snapshot: PublicSnapshot | undefined;
  let projection: PublicProjection | undefined;
  let admissions = 0;
  const ports: BlueprintWorkflowPorts = {
    getPlan: async (branch, planId) => structuredClone(plans.get(JSON.stringify([branch, planId])) ?? null),
    createPlan: async input => {
      calls.push('create');
      const key = JSON.stringify([input.branchName, input.planId]);
      if (plans.has(key)) throw new Error('Already exists');
      const plan: ArchitectPlanRecord = { ...blueprint, id: input.planId!, slug: input.planId!,
        targetBranch: input.branchName, conversationId: input.conversationId,
        projectIds: input.projectIds, projectId: input.projectIds?.[0], revision: 1,
        agsdl: { ...input.agsdl!, revision: 1 } };
      plans.set(key, structuredClone(plan));
      return structuredClone(plan);
    },
    getConversation: async () => ({ id: 'workflow-chat', project_id: 'project' }) as DbConversation,
    preflight: async input => {
      calls.push('preflight');
      const plan = plans.get(JSON.stringify([input.owner.branch, input.owner.planId]))!;
      const source: SourceRevision = { owner: input.owner, revision: String(plan.revision), sourceSha256: id(await sourceDigest(plan.agsdl!.source)) };
      const result = await compilePlan(plan.agsdl!.source, source, registryFixture(documentFixture()));
      return { source, authoredSource: plan.agsdl!.source, staticValid: result.static.valid,
        runtimeSupported: result.runtime.supported, productRuntimeAvailable: result.productRuntimeAvailable,
        registryVersion: 'synthetic-captured/1', diagnostics: [...result.runtime.diagnostics], incomplete: false };
    },
    readIntent: async () => { calls.push('read-intent'); return structuredClone(intent); },
    stage: async input => {
      calls.push('stage');
      intent ??= { formatVersion: '1', key: { scope: input.scope, intentId: input.intentId }, revision: id('1'),
        payload: input.payload, state: { kind: 'prepared' } };
      return structuredClone(intent);
    },
    submit: async () => {
      calls.push('submit');
      if (!intent || intent.payload.kind !== 'start') throw new Error('No start');
      if (intent.state.kind === 'prepared' || intent.state.kind === 'submissionPending') {
        admissions++;
        const plan = plans.get(JSON.stringify([intent.key.scope.owner.branch, intent.key.scope.owner.planId]))!;
        snapshot = { systemStartId: id('native-run'), source: intent.payload.request.source,
          authoredSource: plan.agsdl!.source, versions: { snapshot: '1', contract: 'agsdl-0.2.0', compiler: 'compiler',
            runtime: 'runtime', registry: 'synthetic-captured/1', profile: 'macro-serial-inline-v1' }, associations: {} };
        projection = { systemStartId: snapshot.systemStartId, source: snapshot.source, cursor: id('1'),
          agents: [], activations: [], nextPage: null, systemStop: { kind: 'none' } };
        intent = { ...intent, revision: id('2'), state: { kind: 'admitted', admission: {
          kind: 'start', receipt: { systemStartId: snapshot.systemStartId, flowInvocationId: id('flow'), snapshot },
        } } };
      }
      return structuredClone(intent);
    },
    close: async input => {
      calls.push('close');
      if (intent?.state.kind === 'closed' && intent.state.disposition === input.disposition) return structuredClone(intent);
      if (!intent || intent.state.kind !== 'admitted' || intent.revision !== input.expectedRevision) throw new Error('Conflict');
      intent = { ...intent, revision: id('3'), state: { kind: 'closed', disposition: input.disposition, admission: intent.state.admission } };
      return structuredClone(intent);
    },
    snapshot: async () => { calls.push('snapshot'); return structuredClone(snapshot!); },
    projection: async () => { calls.push('projection'); return structuredClone(projection!); },
  };
  return { blueprint, document, plans, request, calls, ports, get service() { return createBlueprintWorkflowService(ports); },
    admissions: () => admissions, intent: () => intent,
    setIntent: (value: PublicExecutionIntent | null) => { intent = value; } };
}

describe('production blueprint workflow launch', () => {
  it('rejects normalized destination IDs before writes and accepts canonical dotted blueprint IDs', async () => {
    const h = await harness();
    h.request.scope = { ...h.request.scope, owner: { ...h.request.scope.owner, planId: 'WORKFLOW_ONE' } };
    await expect(h.service.prepare(h.request)).rejects.toMatchObject({ code: 'SCOPE_INVALID' });
    expect(h.calls).toEqual([]);
    const dotted = await harness();
    const original = dotted.plans.get(JSON.stringify(['develop', 'template']))!;
    original.id = 'template.v1';
    dotted.plans.set(JSON.stringify(['develop', 'template.v1']), original);
    dotted.request.blueprint.planId = 'template.v1';
    expect((await dotted.service.launch(dotted.request)).snapshot).toBeDefined();
  });

  it('retains successful admission when concurrent native Close is still reserved', async () => {
    const h = await harness();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reserved = new Promise<void>(resolve => { entered = resolve; });
    const close = h.ports.close;
    let busy = false;
    h.ports.close = async input => {
      if (busy) throw { code: 'SUBMISSION_IN_PROGRESS' };
      busy = true; entered();
      await held;
      return close(input);
    };
    const first = h.service.launch(h.request);
    await reserved;
    const second = await h.service.launch(h.request);
    expect(second.intent.state.kind).toBe('admitted');
    expect(second.snapshot!.systemStartId).toBe(id('native-run'));
    release();
    expect((await first).intent.state.kind).toBe('closed');
    expect(h.admissions()).toBe(1);
  });

  it('copies exact source into project metadata and admits through the existing native protocol', async () => {
    const h = await harness();
    const result = await h.service.launch(h.request);
    expect(result.intent.state.kind).toBe('closed');
    expect(result.snapshot!.source.owner).toEqual(h.request.scope.owner);
    expect(result.snapshot!.authoredSource).toBe(h.blueprint.agsdl!.source);
    expect(result.snapshot!.authoredSource).toContain('9007199254740993');
    expect(result.plan.agsdl!.display!.cards!['/flow/steps/work']).toEqual({ title: 'Vérifier' });
    expect(result.plan.agsdl!.annexes).toEqual(h.blueprint.agsdl!.annexes);
    expect(result.plan.agsdl!.design!.origin).toMatchObject(h.request.blueprint);
    expect(await h.ports.getPlan('develop', 'template')).toEqual(h.blueprint);
    expect(h.calls).toEqual(['create', 'read-intent', 'preflight', 'stage', 'submit', 'snapshot', 'projection', 'close']);
    expect(h.admissions()).toBe(1);
  });

  it('accepts a shared library blueprint but refuses a blueprint from another project', async () => {
    const shared = await harness(true);
    expect((await shared.service.launch(shared.request)).snapshot).toBeDefined();
    const scoped = await harness();
    scoped.request.scope = { ...scoped.request.scope, owner: { ...scoped.request.scope.owner, projectId: 'another-project' } };
    scoped.ports.getConversation = async () => ({ project_id: 'another-project' }) as DbConversation;
    await expect(scoped.service.launch(scoped.request)).rejects.toMatchObject({ code: 'BLUEPRINT_UNAVAILABLE' });
    expect(scoped.calls).toEqual([]);
  });

  it('recovers a lost metadata commit acknowledgement and coalesces concurrent launch identities', async () => {
    const h = await harness();
    const create = h.ports.createPlan;
    h.ports.createPlan = async input => { await create(input); throw new Error('Connection lost'); };
    const first = await h.service.prepare(h.request);
    const again = await h.service.prepare(h.request);
    expect(again.id).toBe(first.id);
    expect(h.calls).toEqual(['create']);
    const results = await Promise.all([h.service.launch(h.request), h.service.launch(h.request)]);
    expect(results.map(item => item.snapshot!.systemStartId)).toEqual([id('native-run'), id('native-run')]);
    expect(h.admissions()).toBe(1);
  });

  it('resumes after a lost admission acknowledgement without rechecking live providers or the blueprint', async () => {
    const h = await harness();
    const submit = h.ports.submit;
    h.ports.submit = async key => { await submit(key); throw new Error('Admission acknowledgement lost'); };
    await expect(h.service.launch(h.request)).rejects.toThrow('acknowledgement lost');
    h.plans.delete(JSON.stringify(['develop', 'template']));
    // Recovery reads the historical native capture, even if today's copy was edited.
    h.plans.get(JSON.stringify(['develop', 'workflow-one']))!.agsdl!.source = '{invalid current source';
    h.ports.preflight = async () => { throw new Error('Provider offline'); };
    h.calls.length = 0;
    const result = await h.service.resume(h.request.scope);
    expect(result.snapshot!.systemStartId).toBe(id('native-run'));
    expect(h.calls).toEqual(['read-intent', 'snapshot', 'projection', 'close']);
    expect(h.admissions()).toBe(1);
    h.plans.get(JSON.stringify(['develop', 'workflow-one']))!.agsdl!.source = h.blueprint.agsdl!.source;
    expect((await h.service.launch({ ...h.request, prompt: undefined })).snapshot!.systemStartId).toBe(id('native-run'));
    await expect(h.service.launch({ ...h.request, prompt: 'Another input' })).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
  });

  it('leaves the admitted intent open if projection installation fails, then recovers the same run', async () => {
    const h = await harness();
    const projection = h.ports.projection;
    h.ports.projection = async () => { throw new Error('Projection unavailable'); };
    await expect(h.service.launch(h.request)).rejects.toThrow('Projection unavailable');
    expect(h.intent()!.state.kind).toBe('admitted');
    expect(h.calls).not.toContain('close');
    h.ports.projection = projection;
    expect((await h.service.resume(h.request.scope)).intent.state.kind).toBe('closed');
    expect(h.admissions()).toBe(1);
  });

  it('recovers a lost Stage or Close acknowledgement using the persisted identity in a new service instance', async () => {
    for (const boundary of ['stage', 'close'] as const) {
      const h = await harness();
      if (boundary === 'stage') {
        const stage = h.ports.stage;
        h.ports.stage = async input => { await stage(input); throw new Error('Stage acknowledgement lost'); };
      } else {
        const close = h.ports.close;
        h.ports.close = async input => { await close(input); throw new Error('Close acknowledgement lost'); };
      }
      await expect(h.service.launch(h.request)).rejects.toThrow('acknowledgement lost');
      // The next client need not reconstruct a source, prompt or request id.
      const { close: _close, ...remainingPorts } = h.ports;
      const resumed = createBlueprintWorkflowService({ ...remainingPorts, close: async input => {
        const row = h.intent()!;
        if (row.state.kind === 'admitted') h.setIntent({ ...row, revision: id('3'), state: {
          kind: 'closed', disposition: input.disposition, admission: row.state.admission,
        } });
        return structuredClone(h.intent()!);
      } });
      expect((await resumed.resume(h.request.scope)).snapshot!.systemStartId).toBe(id('native-run'));
      expect(h.admissions()).toBe(1);
    }
  });

  it('returns native pending/refused/discarded states without inventing an execution or retrying in a loop', async () => {
    for (const state of [
      { kind: 'submissionPending' as const, retryableFailure: 'RUNTIME_UNAVAILABLE' as const },
      { kind: 'refused' as const, code: 'SOURCE_CHANGED' as const },
      { kind: 'closed' as const, disposition: 'discarded' as const, admission: null },
    ]) {
      const h = await harness();
      h.ports.submit = async () => { const row = { ...h.intent()!, state }; h.setIntent(row); return row; };
      const result = await h.service.launch(h.request);
      expect(result.intent.state).toEqual(state);
      expect(result.snapshot).toBeUndefined();
      expect(h.admissions()).toBe(0);
      expect(h.calls).not.toContain('close');
    }
  });

  it('refuses a stale blueprint, a foreign conversation and a canonical capture that changes during preflight', async () => {
    const stale = await harness();
    stale.request.blueprint.revision = 3;
    await expect(stale.service.launch(stale.request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(stale.calls).not.toContain('create');
    const foreign = await harness();
    foreign.ports.getConversation = async () => ({ project_id: 'foreign' }) as DbConversation;
    await expect(foreign.service.launch(foreign.request)).rejects.toMatchObject({ code: 'SCOPE_INVALID' });
    expect(foreign.calls).not.toContain('create');
    const changed = await harness();
    const preflight = changed.ports.preflight;
    changed.ports.preflight = async input => ({ ...await preflight(input), authoredSource: '{}' });
    await expect(changed.service.launch(changed.request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(changed.calls).not.toContain('stage');
  });

  it('rejects unsupported composition and missing model capability before staging any effect', async () => {
    for (const mutate of [
      (doc: ReturnType<typeof documentFixture>) => { record(doc.configurations).fixed = {}; },
      (doc: ReturnType<typeof documentFixture>) => { const steps = record(record(doc.flow).steps); record(steps.work).next = ['left', 'right'];
        steps.left = { type: 'agent', agent: 'worker' }; steps.right = { type: 'agent', agent: 'worker' }; },
    ]) {
      const h = await harness();
      mutate(h.document);
      h.plans.get(JSON.stringify(['develop', 'template']))!.agsdl!.source = encode(h.document);
      await expect(h.service.launch(h.request)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
      expect(h.calls).not.toContain('stage'); expect(h.admissions()).toBe(0);
    }
  });

  it('launches a completed configuration on the prepared copy without rewriting the reusable blueprint', async () => {
    const h = await harness();
    record(h.document.configurations).fixed = {};
    const incomplete = encode(h.document);
    h.plans.get(JSON.stringify(['develop', 'template']))!.agsdl!.source = incomplete;
    await expect(h.service.launch(h.request)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    const copy = h.plans.get(JSON.stringify(['develop', 'workflow-one']))!;
    copy.agsdl!.source = h.blueprint.agsdl!.source;
    copy.revision = 2;
    expect((await h.service.launch(h.request)).snapshot!.source.revision).toBe('2');
    expect(h.plans.get(JSON.stringify(['develop', 'template']))!.agsdl!.source).toBe(incomplete);
    expect(h.admissions()).toBe(1);
  });

  it('requires flow input and never silently drops input for a graphless blueprint', async () => {
    const h = await harness();
    await expect(h.service.launch({ ...h.request, prompt: undefined })).rejects.toMatchObject({ code: 'INPUT_REQUIRED' });
    expect(h.calls).not.toContain('stage');
    const graphless = await harness();
    delete graphless.document.flow;
    graphless.plans.get(JSON.stringify(['develop', 'template']))!.agsdl!.source = encode(graphless.document);
    await expect(graphless.service.launch(graphless.request)).rejects.toMatchObject({ code: 'INPUT_NOT_APPLICABLE' });
    expect((await graphless.service.launch({ ...graphless.request, prompt: undefined })).snapshot).toBeDefined();
  });

  it('freezes caller inputs before awaiting project lookup and refuses identity reuse', async () => {
    const h = await harness();
    const lookup = h.ports.getConversation;
    h.ports.getConversation = async value => { Object.assign(h.request.scope.owner, { projectId: 'changed' }); h.request.blueprint.planId = 'changed'; return lookup(value); };
    const result = await h.service.launch(h.request);
    expect(result.plan.projectIds).toEqual(['project']);
    h.ports.getConversation = lookup;
    const conflict = { ...h.request, blueprint: { ...h.request.blueprint, planId: 'other' },
      scope: { ...h.request.scope, owner: { ...h.request.scope.owner, projectId: 'project' } } };
    await expect(h.service.prepare(conflict)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
  });

  it('does not acknowledge a mismatched native snapshot, source or intent scope', async () => {
    for (const kind of ['snapshot', 'source', 'scope'] as const) {
      const h = await harness();
      const read = h.ports.snapshot;
      h.ports.snapshot = async systemStartId => { const snapshot = await read(systemStartId);
        return kind === 'snapshot' ? { ...snapshot, systemStartId: id('foreign') } :
          { ...snapshot, authoredSource: '{}', source: { ...snapshot.source, sourceSha256: id('0'.repeat(64)) } }; };
      if (kind === 'scope') {
        await expect(h.service.launch(h.request)).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });
        const row = structuredClone(h.intent()!); Object.assign(row.key.scope.owner, { planId: 'foreign' }); h.setIntent(row);
        h.ports.snapshot = read;
        await expect(h.service.resume(h.request.scope)).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });
      } else await expect(h.service.launch(h.request)).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });
      expect(h.calls).not.toContain('close');
    }
  });
});
