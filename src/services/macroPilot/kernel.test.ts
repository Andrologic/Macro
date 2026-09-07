import { describe, expect, it } from 'bun:test';
import { PilotKernel, type KernelDependencies, type KernelStorage } from './kernel';
import { object, type Command, type Delivery, type Resource } from './protocol';
import reviewFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/review.json';
import taskFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/task.json';
import decisionFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/decision.json';
import toolApprovalFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/tool-approval.json';
import commandFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/task-reply-command.json';

function setup() {
  let persisted: string | null = null; let available = true; let effects = 0;
  let task = { ...structuredClone(taskFixture), state: 'waiting_reply', reply_context: { conversation_id: 'conversation:test' }, revision: 7 } as Resource;
  let extraSnapshots: Resource[] = [];
  const storage: KernelStorage = { load: async () => persisted, compareAndSwap: async (previous,next) => {
    if (!available || persisted !== previous) return false; persisted = next; return true;
  } };
  const deps: KernelDependencies = {
    instanceId: task.ref.instance_id, storage,
    project: () => ({snapshots:[structuredClone(task), ...structuredClone(extraSnapshots)],state:{version:1}}),
    authorize: async () => new Date(Date.now()+5000).toISOString(),
    execute: async (_command, guard) => {
      await guard.authorizeBeforeEffect(); guard.assertCurrent(); effects++;
      task = {...task,state:'running',revision:task.revision+1}; delete task.reply_context;
    },
  };
  const command = {...structuredClone(commandFixture), target:task.ref, payload:{conversation_id:'conversation:test',answer:'Continue.'}} as Command;
  const delivery: Delivery = {transport_version:'1.0',type:'delivery',exchange_id:'exchange:test-01',delivery_id:'delivery:test-01',actor:command.issued_by,message:command};
  return {deps,delivery,storage,get effects(){return effects;},setTask:(next:Resource)=>{task=next;},setExtraSnapshots:(next:Resource[])=>{extraSnapshots=next;},setPersisted:(next:string)=>{persisted=next;},get task(){return task;},get persisted(){return persisted;},failStorage:()=>{available=false;}};
}
const response = (value: unknown) => object(object(value).message);
const pageDelivery = (delivery: Delivery, scope: Record<string, string>, limit = 200): Delivery => ({
  ...delivery,
  message: { contract_version: '1.0', type: 'page_request', item_type: 'task', scope, limit },
});
const resumeDelivery = (delivery: Delivery, point: Record<string, unknown>, limit = 1000): Delivery => ({
  ...delivery,
  message: { contract_version: '1.0', type: 'resume_request', ...point, limit },
});

describe('Pilot durable desktop dispatch', () => {
  it('applies one effect and replays the stored result after restart or lost response',async()=>{
    const env=setup(); const kernel=new PilotKernel(env.deps); await kernel.initialize();
    const first=await kernel.handle(env.delivery); expect(response(first).outcome).toBe('accepted'); expect(env.effects).toBe(1);
    expect(await kernel.handle(env.delivery)).toEqual(first);
    const restarted=new PilotKernel(env.deps); await restarted.initialize();
    expect(await restarted.handle(env.delivery)).toEqual(first); expect(env.effects).toBe(1);
  });
  it('rejects changed idempotent content before revision and foreign scopes or actor',async()=>{
    const env=setup(); const kernel=new PilotKernel(env.deps); await kernel.initialize(); await kernel.handle(env.delivery);
    const changed=structuredClone(env.delivery); changed.message.expected_revision=99;
    expect(object(response(await kernel.handle(changed)).error).code).toBe('conflict');
    const foreign=structuredClone(env.delivery); object(foreign.message.target).instance_id='instance:foreign';
    expect(object(response(await kernel.handle(foreign)).error).code).toBe('invalid_reference');
    const actor=structuredClone(env.delivery); actor.actor={...actor.actor,session_id:'session:foreign'};
    expect(object(response(await kernel.handle(actor)).error).code).toBe('forbidden'); expect(env.effects).toBe(1);
  });
  it('rechecks state after asynchronous authorization and refuses unavailable persistence',async()=>{
    const env=setup(); let authorizations=0;
    env.deps.authorize=async()=>{ if(++authorizations===2) env.setTask({...env.task,revision:8}); return new Date(Date.now()+5000).toISOString(); };
    const kernel=new PilotKernel(env.deps); await kernel.initialize();
    await kernel.handle(env.delivery); expect(env.effects).toBe(0);
    const broken=setup(); const other=new PilotKernel(broken.deps); await other.initialize(); broken.failStorage();
    expect(object(response(await other.handle(broken.delivery)).error).code).toBe('conflict'); expect(broken.effects).toBe(0);
  });
  it('keeps a crash-window mutation indeterminate and never retries it automatically',async()=>{
    const env=setup(); let executions=0;
    env.deps.execute=async()=>{ executions++; throw Error('A native mutation may have happened'); };
    const kernel=new PilotKernel(env.deps); await kernel.initialize();
    expect(object(response(await kernel.handle(env.delivery)).error).code).toBe('conflict');
    const restarted=new PilotKernel(env.deps); await restarted.initialize();
    expect(restarted.indeterminate()).toHaveLength(1); await restarted.handle(env.delivery); expect(executions).toBe(1);
    await restarted.reconcileNotExecuted(restarted.indeterminate()[0].key);
    expect(response(await restarted.handle(env.delivery)).outcome).toBe('rejected'); expect(executions).toBe(1);
  });
  it('returns a coherent task bootstrap cursor and resumes changes after that point',async()=>{
    const env=setup(); const kernel=new PilotKernel(env.deps); await kernel.initialize();
    const read={...env.delivery,message:{contract_version:'1.0',type:'page_request',item_type:'task',scope:{type:'instance',instance_id:env.deps.instanceId},limit:1}};
    const page=await kernel.handle(read); expect(response(page).type).toBe('page'); const point=object(page.resume_point);
    await kernel.handle(env.delivery);
    const resumed=await kernel.handle({...read,message:{contract_version:'1.0',type:'resume_request',...point,limit:10}});
    expect(response(resumed).type).toBe('event_batch'); expect((response(resumed).events as unknown[]).length).toBe(1);
    kernel.close(); expect(object(response(await kernel.handle(read)).error).code).toBe('unavailable');
  });
  it('keeps instance and workspace streams distinct, scoped, contiguous, and durable', async () => {
    const env = setup();
    const otherWorkspace = structuredClone(taskFixture) as Resource;
    otherWorkspace.ref = { ...otherWorkspace.ref, workspace_id: 'workspace:other', task_id: 'task:other' };
    otherWorkspace.project_ids = ['project:other'];
    otherWorkspace.context_project_ids = [];
    otherWorkspace.execution_targets = [{ project_id: 'project:other', execution_mode: 'git' }];
    env.setExtraSnapshots([otherWorkspace]);
    const kernel = new PilotKernel(env.deps); await kernel.initialize();
    const instancePage = await kernel.handle(pageDelivery(env.delivery, { type: 'instance', instance_id: env.deps.instanceId }));
    const workspacePage = await kernel.handle(pageDelivery(env.delivery, { type: 'workspace', instance_id: env.deps.instanceId, workspace_id: env.task.ref.workspace_id }));
    const instancePoint = object(instancePage.resume_point); const workspacePoint = object(workspacePage.resume_point);
    expect(instancePoint.stream_id).not.toBe(workspacePoint.stream_id);

    env.setTask({ ...env.task, revision: env.task.revision + 1 });
    env.setExtraSnapshots([{ ...otherWorkspace, revision: otherWorkspace.revision + 1 }]);
    await kernel.observe();
    const instanceBatch = response(await kernel.handle(resumeDelivery(env.delivery, instancePoint)));
    expect((instanceBatch.events as Array<Record<string, unknown>>).map(event => event.sequence)).toEqual([1, 2]);

    const restarted = new PilotKernel(env.deps); await restarted.initialize();
    const workspaceBatch = response(await restarted.handle(resumeDelivery(env.delivery, workspacePoint)));
    const workspaceEvents = workspaceBatch.events as Array<Record<string, unknown>>;
    expect(workspaceEvents.map(event => event.sequence)).toEqual([1]);
    expect(workspaceEvents[0].resource).toEqual(env.task.ref);
  });
  it('matches multi-project task membership for project-scoped descendant events', async () => {
    const env = setup(); const decision = structuredClone(decisionFixture) as Resource;
    env.setExtraSnapshots([decision]);
    const kernel = new PilotKernel(env.deps); await kernel.initialize();
    const projectScope = { type: 'project', instance_id: env.deps.instanceId, workspace_id: env.task.ref.workspace_id, project_id: 'project:macro-mobile' };
    const page = await kernel.handle(pageDelivery(env.delivery, projectScope));
    expect((response(page).items as Resource[]).map(item => item.ref.task_id)).toEqual([env.task.ref.task_id]);
    env.setExtraSnapshots([{ ...decision, revision: decision.revision + 1 }]); await kernel.observe();
    const batch = response(await kernel.handle(resumeDelivery(env.delivery, object(page.resume_point))));
    expect((batch.events as Array<Record<string, unknown>>).map(event => object(event.resource).decision_id)).toEqual([decision.ref.decision_id]);
  });
  it('freezes pagination and expires the old page and stream when a task disappears', async () => {
    const env = setup(); const second = structuredClone(taskFixture) as Resource;
    second.ref = { ...second.ref, task_id: 'task:second' }; second.title = 'Second task';
    env.setExtraSnapshots([second]);
    const kernel = new PilotKernel(env.deps); await kernel.initialize();
    const scope = { type: 'instance', instance_id: env.deps.instanceId };
    const first = await kernel.handle(pageDelivery(env.delivery, scope, 1));
    const nextCursor = String(response(first).next_cursor); const point = object(first.resume_point);
    env.setExtraSnapshots([]); await kernel.observe();
    expect(object(response(await kernel.handle(resumeDelivery(env.delivery, point))).error).code).toBe('cursor_expired');
    const oldPage = pageDelivery(env.delivery, scope, 1); oldPage.message.cursor = nextCursor;
    expect(object(response(await kernel.handle(oldPage)).error).code).toBe('cursor_expired');
    const fresh = await kernel.handle(pageDelivery(env.delivery, scope));
    expect((response(fresh).items as Resource[]).map(item => item.ref.task_id)).toEqual([env.task.ref.task_id]);
    expect(object(response(await kernel.handle(oldPage)).error).code).toBe('cursor_expired');
  });
  it('expires scoped streams when decisions or tool approvals disappear', async () => {
    const env = setup(); const decision = structuredClone(decisionFixture) as Resource; const approval = structuredClone(toolApprovalFixture) as Resource;
    env.setExtraSnapshots([decision, approval]);
    const kernel = new PilotKernel(env.deps); await kernel.initialize();
    const scope = { type: 'instance', instance_id: env.deps.instanceId };
    const first = await kernel.handle(pageDelivery(env.delivery, scope));
    env.setExtraSnapshots([approval]); await kernel.observe();
    expect(object(response(await kernel.handle(resumeDelivery(env.delivery, object(first.resume_point)))).error).code).toBe('cursor_expired');
    const second = await kernel.handle(pageDelivery(env.delivery, scope));
    env.setExtraSnapshots([]); await kernel.observe();
    expect(object(response(await kernel.handle(resumeDelivery(env.delivery, object(second.resume_point)))).error).code).toBe('cursor_expired');
  });
  it('bounds persisted scoped streams and expires the least recently bootstrapped cursor', async () => {
    const env = setup(); const kernel = new PilotKernel(env.deps); await kernel.initialize();
    let firstPoint: Record<string, unknown> = {}; let latestPoint: Record<string, unknown> = {};
    for (let index = 0; index < 129; index++) {
      const page = await kernel.handle(pageDelivery(env.delivery, {
        type: 'workspace', instance_id: env.deps.instanceId, workspace_id: `workspace:retention-${index}`,
      }));
      if (index === 0) firstPoint = object(page.resume_point);
      latestPoint = object(page.resume_point);
    }
    expect(Object.keys(object(JSON.parse(env.persisted!)).streams as object)).toHaveLength(128);
    expect(object(response(await kernel.handle(resumeDelivery(env.delivery, firstPoint))).error).code).toBe('cursor_expired');
    expect(response(await kernel.handle(resumeDelivery(env.delivery, latestPoint))).events).toEqual([]);
  });
  it('migrates the shared legacy stream by expiring its cursor without inventing scoped history', async () => {
    const env = setup(); const initial = new PilotKernel(env.deps); await initial.initialize();
    const page = await initial.handle(pageDelivery(env.delivery, { type: 'instance', instance_id: env.deps.instanceId }));
    const oldPoint = object(page.resume_point); const persisted = object(JSON.parse(env.persisted!));
    env.setPersisted(JSON.stringify({ ...persisted, version: 1, streamId: oldPoint.stream_id, sequence: 0, events: [], streams: undefined }));
    const migrated = new PilotKernel(env.deps); await migrated.initialize();
    expect(object(response(await migrated.handle(resumeDelivery(env.delivery, oldPoint))).error).code).toBe('cursor_expired');
    const fresh = await migrated.handle(pageDelivery(env.delivery, { type: 'instance', instance_id: env.deps.instanceId }));
    expect(object(fresh.resume_point).stream_id).not.toBe(oldPoint.stream_id);
    expect(object(JSON.parse(env.persisted!)).version).toBe(2);
  });
  it('rejects a consumed task reply before any desktop effect',async()=>{
    // A stale task reply cannot be repurposed as a start or another conversation.
    const env=setup(); const kernel=new PilotKernel(env.deps); await kernel.initialize();
    env.setTask({...env.task,revision:8});
    expect(object(response(await kernel.handle(env.delivery)).error).code).toBe('stale_revision'); expect(env.effects).toBe(0);
  });
  it('refuses a review when Git changes during relay authorization', async () => {
    const env = setup();
    let checks = 0;
    env.deps.validateReview = async () => { if (++checks > 1) throw new Error('Git changed'); };
    const kernel = new PilotKernel(env.deps);
    await kernel.initialize();
    const review = { ...structuredClone(reviewFixture), state: 'pending' } as Resource;
    await kernel.recordReview(review);
    const command = { ...env.delivery.message, kind: 'review.submit', target: review.ref, expected_revision: review.revision, payload: { verdict: 'approve' } };
    const result = response(await kernel.handle({ ...env.delivery, message: command }));
    expect(result.outcome).toBe('rejected');
    expect(checks).toBe(2);
    expect(env.effects).toBe(0);
  });
  it('marks an uncertain start interrupted instead of retaining a pending run', async () => {
    const env = setup();
    const task: Resource = { ...env.task, state: 'queued' }; delete task.reply_context;
    env.setTask(task);
    env.deps.execute = async () => { throw new Error('Preparation interrupted'); };
    const kernel = new PilotKernel(env.deps); await kernel.initialize();
    await kernel.handle({ ...env.delivery, message: { ...env.delivery.message, kind: 'run.start', payload: { run_id: 'run:new-01' } } });
    expect(kernel.getKnownRuns()[0].interruptedAt).toBeString();
    const restarted = new PilotKernel(env.deps); await restarted.initialize();
    expect(restarted.getKnownRuns()[0].interruptedAt).toBeString();
    expect(restarted.indeterminate()).toHaveLength(1);
  });

});
