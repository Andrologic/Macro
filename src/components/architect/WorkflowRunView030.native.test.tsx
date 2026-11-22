import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkflowRunView030 } from './ArchitectStrategyPanel';
import { createRunInspectionAccess030 } from '../../services/agsdl/runAccess030';
import { nativeAgentRunFixture030, nativeTransportFor030 } from '../../services/agsdl/runAccess030.testSupport';
import { RunInspectionDouble030 } from '../../services/agsdl/runInspection030.testSupport';
import { createHumanRequestClient030 } from '../../services/agsdl/humanRequests030';
import { humanFixture030, memoryDraftStorage030 } from '../agsdl/HumanRequests030.test-fixtures';
import { createReadOnlyHumanRequestClient030 } from '../../services/agsdl/humanReadAccess030';
import { notifiedHumanRequests030 } from '../../services/agsdl/humanAttention030';
import { subscribeRunAttention030 } from '../notifications/WorkflowAttentionNotifications';
import { notify } from '../ui/toastService';
import i18n from '../../i18n';
import type { RunInspectionAccess030 } from '../../services/agsdl/runtimeProjection030';

let root: Root | undefined; let host: HTMLDivElement;
let notification: ReturnType<typeof spyOn<typeof notify,'actionRequired'>>;
beforeEach(() => { notifiedHumanRequests030.clear(); notification=spyOn(notify,'actionRequired').mockReturnValue('test'); });
afterEach(async()=>{ await act(async()=>root?.unmount()); root=undefined;host?.remove();notification.mockRestore(); });
async function observedNativeRun() {
  const f=await nativeAgentRunFixture030(); const {transport,scope}=nativeTransportFor030(f);
  const access=createRunInspectionAccess030(scope,transport); await access.refreshHistory();await access.refreshRun(f.capture.systemStartId);
  return {f,transport,access};
}
async function mount(access:RunInspectionAccess030, client:ReturnType<typeof createHumanRequestClient030>, target?:Parameters<typeof WorkflowRunView030>[0]['target']) {
  if(!root){host=document.createElement('div');document.body.append(host);root=createRoot(host);}
  await act(async()=>root!.render(<WorkflowRunView030 bundle={{access,humanClient:client}} target={target} />));
}
it('shows native human unavailability and a refresh message after an encompassing read conflict',async()=>{
  const {f,transport,access}=await observedNativeRun();
  const client=createReadOnlyHumanRequestClient030(f.scope,memoryDraftStorage030(),transport);
  await mount(access,client,{scope:f.scope});
  expect(host.querySelector('form')).toBeNull(); expect(notification).not.toHaveBeenCalled();
  transport.readExecutionRuntimeProjection030=async()=>{throw {code:'CONFLICT',message:'Native revision changed'};};
  await act(async()=>{await access.refreshRun(f.capture.systemStartId).catch(()=>undefined);});
  expect(access.getSnapshot().runs[f.capture.systemStartId].kind).toBe('stale');
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).toContain(i18n.t('agsdl.human030.stale',{ns:'agsdl'}));
  expect(notification).not.toHaveBeenCalled();
});

/** The current native DTO cannot qualify humans. These two renderer checks add
 * an explicitly qualified product DTO to a real native capture/runtime so a
 * future human reader cannot accidentally enable retained stale requests. */
async function qualifiedRetainedRequest() {
  const {f,access}=await observedNativeRun();const snapshot=access.getSnapshot();
  const read=snapshot.runs[f.capture.systemStartId]; if(read.kind!=='ready')throw new Error('No native observation');
  const request=humanFixture030({scope:{systemStartId:f.capture.systemStartId,source:f.capture.source},
    occurrences:[{workId:'public-human-work',activation:{kind:'available',scope:f.scope,activationId:'activation-1'}}]});
  const inspection={...read.value,state:{...read.value.state,humans:{kind:'ready' as const,revision:request.revision,value:[request]}}};
  const observed=new RunInspectionDouble030({...snapshot,runs:{[f.capture.systemStartId]:{...read,value:inspection}}});
  const client=createHumanRequestClient030({storage:memoryDraftStorage030(),read:async()=>request,submit:async()=>{throw new Error('No submission authorized');}});
  return {f,request,inspection,observed,client};
}
it('disables retained human forms and emits no attention when the enclosing native observation is stale',async()=>{
  const {f,inspection,observed,client}=await qualifiedRetainedRequest();
  observed.publish({...observed.snapshot,runs:{[f.capture.systemStartId]:{kind:'stale',revision:inspection.state.revision,retained:inspection,
    refusal:{code:'REVISION_CONFLICT',message:'Native revision changed',currentRevision:null}}}});
  await mount(observed,client,{scope:f.scope});
  expect(host.querySelector('form')).not.toBeNull();
  expect([...host.querySelectorAll('form button')].every(item=>(item as HTMLButtonElement).disabled)).toBe(true);
  expect(notification).not.toHaveBeenCalled();
  expect(host.textContent).toContain(i18n.t('agsdl.human030.stale',{ns:'agsdl'}));
});
it('shares attention deduplication through remount and never refocuses a request on reader publication during typing',async()=>{
  const {f,request,inspection,observed,client}=await qualifiedRetainedRequest();
  const stop = subscribeRunAttention030([{scope:{owner:f.capture.source.owner,conversationId:'design-conversation'},access:observed}],i18n.getFixedT('en','agsdl'));
  const target={scope:request.scope,requestId:request.id,conversationId:'design-conversation'};
  await mount(observed,client,target);
  await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});
  expect(notification).toHaveBeenCalledTimes(1);
  const field=host.querySelector('textarea')!;field.focus();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,'Draft');field.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>observed.publish({...observed.snapshot,runs:{[f.capture.systemStartId]:{kind:'ready',revision:inspection.state.revision,value:{...inspection}}}}));
  await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});
  expect(document.activeElement).toBe(field); expect(field.value).toBe('Draft');
  await act(async()=>root!.unmount());root=undefined;host.remove();
  await mount(observed,client,target);
  expect(notification).toHaveBeenCalledTimes(1);
  stop();
});

it('shows an intent read failure alongside independently read 030 and historical tasks',async()=>{
  const {loadWorkflowAgentTasks,configureWorkflowRunAccess030,getWorkflowRunAccess030}=await import('../../services/workflowAgentTasks');
  const {workflowTaskFixture}=await import('../../services/workflowAgentTasks.fixtures');
  const old=await workflowTaskFixture();const f=await nativeAgentRunFixture030();const {transport,scope}=nativeTransportFor030(f);
  transport.readExecutionIntentsVersioned=async()=>{throw {code:'SCOPE_INVALID',message:'Native intent scope rejected'};};
  configureWorkflowRunAccess030(candidate=>({access:createRunInspectionAccess030({...candidate,conversationId:candidate.conversationId!},transport)}));
  try{
    const plans=[old.plan,{...old.plan,id:'sample-plan',projectIds:['sample-project'],conversationId:'design-conversation',agsdl:{revision:1,source:f.capture.authoredSource,annexes:{}}}];
    const ports={...old.ports,runs:async(request:Parameters<typeof old.ports.runs>[0])=>request.owner.projectId==='project'?{runs:[old.summary],nextCursor:null}:{runs:[],nextCursor:null}};
    const tasks = await loadWorkflowAgentTasks(plans,null,ports);
    expect(tasks.filter(task => task.workflow_execution?.systemStartId === old.snapshot.systemStartId)).toHaveLength(2);
    expect(tasks.filter(task => task.workflow_execution?.systemStartId === f.capture.systemStartId)).toHaveLength(1);
    expect(tasks.find(task => task.workflow_execution?.systemStartId === f.capture.systemStartId)?.workflow_execution?.stale).not.toBe(true);
    host=document.createElement('div');document.body.append(host);root=createRoot(host);
    await act(async()=>root!.render(<WorkflowRunView030 bundle={getWorkflowRunAccess030(scope)!} />));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain('SCOPE_INVALID');
    expect(host.textContent).toContain('Native intent scope rejected');
  }finally{
    await act(async()=>root?.unmount());root=undefined;
    configureWorkflowRunAccess030(undefined);
  }
});

it('renders a failed first native read as an error instead of an indefinite loading history',async()=>{
  const {f}=await observedNativeRun();
  const {removeTauriRuntimeMock}=await import('../../test-utils/tauriRuntime');removeTauriRuntimeMock();
  const access=createRunInspectionAccess030({owner:f.scope.source.owner,conversationId:'design-conversation'});
  const client=createReadOnlyHumanRequestClient030(f.scope,memoryDraftStorage030());
  await mount(access,client);
  expect(access.getSnapshot().history.kind).toBe('error');
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.textContent).toContain(i18n.t('agsdl.run030.readFailed',{ns:'agsdl'}));
  expect(host.textContent).not.toContain(i18n.t('agsdl.run030.loading',{ns:'agsdl'}));
});
