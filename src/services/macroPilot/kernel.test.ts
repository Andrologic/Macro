import { describe, expect, it } from 'bun:test';
import { PilotKernel, type KernelDependencies, type KernelStorage } from './kernel';
import { object, type Command, type Delivery, type Resource } from './protocol';
import reviewFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/review.json';
import taskFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/task.json';
import commandFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/task-reply-command.json';

function setup() {
  let persisted: string | null = null; let available = true; let effects = 0;
  let task = { ...structuredClone(taskFixture), state: 'waiting_reply', reply_context: { conversation_id: 'conversation:test' }, revision: 7 } as Resource;
  const storage: KernelStorage = { load: async () => persisted, compareAndSwap: async (previous,next) => {
    if (!available || persisted !== previous) return false; persisted = next; return true;
  } };
  const deps: KernelDependencies = {
    instanceId: task.ref.instance_id, storage,
    project: () => ({snapshots:[structuredClone(task)],state:{version:1}}),
    authorize: async () => new Date(Date.now()+5000).toISOString(),
    execute: async (_command, guard) => {
      await guard.authorizeBeforeEffect(); guard.assertCurrent(); effects++;
      task = {...task,state:'running',revision:task.revision+1}; delete task.reply_context;
    },
  };
  const command = {...structuredClone(commandFixture), target:task.ref, payload:{conversation_id:'conversation:test',answer:'Continue.'}} as Command;
  const delivery: Delivery = {transport_version:'1.0',type:'delivery',exchange_id:'exchange:test-01',delivery_id:'delivery:test-01',actor:command.issued_by,message:command};
  return {deps,delivery,storage,get effects(){return effects;},setTask:(next:Resource)=>{task=next;},get task(){return task;},get persisted(){return persisted;},failStorage:()=>{available=false;}};
}
const response = (value: unknown) => object(object(value).message);

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
    const task = { ...env.task, state: 'queued' }; delete task.reply_context;
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
