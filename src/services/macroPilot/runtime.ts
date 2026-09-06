import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { isAppShutdownGateActive } from '../appShutdownGate';
import { gitBranchList, gitReviewSnapshot } from '../tauriIpc';
import { desktopActions, type DesktopToolApprovalPayload } from './desktopActions';
import { PilotKernel, type KernelDependencies, type KnownRun } from './kernel';
import { macroPilotNativeClient, type MacroPilotNativeClient } from './nativeClient';
import { projectDesktopSnapshots, toolApprovalSourceKey, type LocalResolutionEvidence, type ProjectionState, type ToolApprovalResolutionEvidence } from './projection';
import { object, PilotError, same, stableJson, type Command, type Resource } from './protocol';
import { pilotKernelStorage } from './storage';

interface RuntimeProjectionState {
  desktop: ProjectionState | null;
  runs: Record<string, { fingerprint: string; revision: number; snapshot: Resource }>;
  decisionEvidence: Record<string, LocalResolutionEvidence>;
  approvalEvidence: Record<string, ToolApprovalResolutionEvidence>;
}
const emptyProjection = (): RuntimeProjectionState => ({desktop:null,runs:{},decisionEvidence:{},approvalEvidence:{}});
const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort',done); resolve(); };
  const timer=setTimeout(done,ms); signal.addEventListener('abort',done,{once:true});
});

export class PilotRuntime {
  private kernel: PilotKernel | null = null;
  private controller: AbortController | null = null;
  private identity: string | null = null;
  private generation = 0;
  private started = false;
  private unsubscribers: Array<()=>void> = [];
  private localRuns = new Set<string>();
  private decisionEvidence: Record<string, LocalResolutionEvidence> = {};
  private approvalEvidence: Record<string, ToolApprovalResolutionEvidence> = {};
  private approvalObservedAt: Record<string, string> = {};
  private activeLoop: Promise<void> | null = null;
  constructor(
    private readonly client: Pick<MacroPilotNativeClient, 'getState' | 'subscribe' | 'initialize' | 'request'> = macroPilotNativeClient,
    private readonly createKernel: (dependencies: KernelDependencies) => PilotKernel = dependencies => new PilotKernel(dependencies),
  ) {}
  async start(): Promise<void> {
    if (this.started) return; this.started=true;
    this.unsubscribers.push(this.client.subscribe(()=>{void this.synchronize();}));
    await this.client.initialize(); await this.synchronize();
  }
  private async synchronize() {
    const state=this.client.getState();
    const instanceId=state.instance?.ref.instance_id;
    const next=['connected','offline'].includes(state.status) && state.configurationId && instanceId && state.deviceSession?.state==='active'
      ? stableJson([state.configurationId,instanceId,state.deviceSession.ref.session_id]) : null;
    if (next===this.identity || !this.started) return;
    this.generation++; const generation=this.generation;
    this.controller?.abort(); this.kernel?.close(); this.kernel=null;
    this.identity=next;
    if (!next || !instanceId || !state.configurationId) return;
    // A previous loop must stop before this instance starts another producer poll.
    await this.activeLoop?.catch(()=>undefined);
    if (generation!==this.generation) return;
    const controller=new AbortController(); this.controller=controller;
    const authorize=async (delivery: {delivery_id:string}) => {
      if(controller.signal.aborted || isAppShutdownGateActive()) throw new PilotError('unavailable');
      const response=await this.client.request('POST',`/instances/${encodeURIComponent(instanceId)}/deliveries/${encodeURIComponent(delivery.delivery_id)}/authorize`,{transport_version:'1.0'},{authenticated:true,producer:true,signal:controller.signal});
      const deadline=object(response.data).execute_before;
      if(typeof deadline!=='string') throw new PilotError('unavailable'); return deadline;
    };
    const kernel: PilotKernel=this.createKernel({
      instanceId,storage:pilotKernelStorage(state.configurationId,instanceId),
      project:(previous,now,runs)=>this.project(previous,now,runs,instanceId,state.configurationId!),
      authorize,
      validateReview: review => this.validateReview(review),
      execute:async(command,guard)=>{
        if (isAppShutdownGateActive()) throw new PilotError('unavailable');
        if(command.kind==='run.start') {
          const result=await desktopActions.start(command.target.task_id,guard);
          this.localRuns.add(String(command.payload.run_id)); return result;
        }
        if(command.kind==='task.reply') return desktopActions.reply(command.target.task_id,String(command.payload.conversation_id),String(command.payload.answer),guard);
        if(command.kind==='decision.resolve') {
          await desktopActions.answerDecision(this.decisionRef(command),command.payload.answers as Array<{step_id:string;answer:string}>,guard);
          this.decisionEvidence[command.target.assistant_message_id]={resolvedAt:new Date().toISOString(),resolvedBy:command.issued_by}; return;
        }
        if(command.kind==='tool_approval.resolve') {
          const ref={conversation_id:command.target.conversation_id,assistant_message_id:command.target.assistant_message_id,tool_call_id:command.target.tool_call_id};
          await desktopActions.resolveApproval(ref,command.payload as DesktopToolApprovalPayload,guard);
          const key=toolApprovalSourceKey({conversationId:ref.conversation_id,assistantMessageId:ref.assistant_message_id,toolCallId:ref.tool_call_id});
          this.approvalEvidence[key]={verdict:command.payload.verdict as 'approve'|'deny',
            ...(command.payload.grant_scope?{grantScope:command.payload.grant_scope as 'once'|'conversation'}:{}),
            ...(command.payload.reason?{reason:String(command.payload.reason)}:{}),resolvedAt:new Date().toISOString(),resolvedBy:command.issued_by}; return;
        }
        if(command.kind==='run.cancel') {
          const bound=kernel.getKnownRuns().find(run=>run.runId===command.target.run_id && run.taskRef.task_id===command.target.task_id && run.taskRef.workspace_id===command.target.workspace_id);
          if(!bound?.conversationId) throw new PilotError('invalid_reference');
          return desktopActions.cancel(bound.conversationId,guard);
        }
        throw new PilotError('validation_failed');
      },
    });
    try {
      await kernel.initialize(); if(generation!==this.generation) {kernel.close(); return;}
      this.kernel=kernel;
      this.activeLoop=this.poll(kernel,instanceId,controller.signal).catch(()=>undefined);
    } catch { controller.abort(); this.identity=null; }
  }
  private decisionRef(command:Command) {
    if(!command.target.conversation_id || !command.target.assistant_message_id) throw new PilotError('invalid_reference');
    return {conversation_id:command.target.conversation_id,assistant_message_id:command.target.assistant_message_id,task_id:command.target.task_id};
  }
  private project(previous:unknown,now:string,runs:KnownRun[],instanceId:string,configurationId:string) {
    const persisted=previous ? previous as RuntimeProjectionState : emptyProjection();
    const app=useAppStore.getState(); const chat=useChatStore.getState(); const tasks=useTaskStore.getState().tasks;
    const projects=[...new Map([...app.standaloneProjects,...app.projectGroups.flatMap(group=>group.projects)].map(project=>[project.id,project])).values()];
    const knownRuns=runs.filter((run): run is KnownRun & { startedAt: string } => Boolean(run.startedAt)).map(run=>({taskId:run.taskRef.task_id,runId:run.runId,startedAt:run.startedAt,finishedAt:persisted.runs[run.runId]?.snapshot.finished_at as string | undefined}));
    const decisions={...persisted.decisionEvidence,...this.decisionEvidence}; const approvals={...persisted.approvalEvidence,...this.approvalEvidence};
    for (const approval of Object.values(chat.pendingToolApprovalByConversationId)) {
      if (!approval || approval.recoveryState === 'interrupted') continue;
      const conversation = chat.conversations.find(item => item.id === approval.conversationId);
      if (!runs.some(run => this.localRuns.has(run.runId) && run.taskRef.task_id === conversation?.task_id)) continue;
      const key = toolApprovalSourceKey(approval);
      this.approvalObservedAt[key] ??= now;
    }
    const result=projectDesktopSnapshots({instance:{instanceId,label:this.client.getState().instance?.label??'Macro',connectionState:'reachable'},
      workspace:{workspaceId:`workspace:${configurationId}`,label:'Macro'},projects,tasks,conversations:chat.conversations,
      messages:chat.messages,messagesByConversationId:chat.messagesByConversationId,
      questionnaireDraftsByConversationId:chat.questionnaireDraftsByConversationId,pendingToolApprovalByConversationId:chat.pendingToolApprovalByConversationId,
      runningTaskIds:new Set(chat.conversations.filter(conversation=> {
        const phase=chat.conversationRuntimeById[conversation.id]?.phase; return phase && phase!=='idle' && phase!=='error';
      }).map(conversation=>conversation.task_id).filter((id):id is string=>Boolean(id))),knownRuns,toolApprovalObservedAtBySourceKey:this.approvalObservedAt,
      localDecisionResolutionsByAssistantMessageId:decisions,toolApprovalResolutionsBySourceKey:approvals},persisted.desktop,now);
    const snapshots:Resource[]=[result.snapshots.instance,result.snapshots.workspace,...result.snapshots.projects,...result.snapshots.tasks,...result.snapshots.decisions,...result.snapshots.toolApprovals];
    const nextRuns={...persisted.runs};
    for(const run of runs) {
      const previousRun=persisted.runs[run.runId]; const task=result.snapshots.tasks.find(task=>same(task.ref,run.taskRef));
      if(!task) continue;
      const phase=run.conversationId?chat.conversationRuntimeById[run.conversationId]?.phase:undefined;
      let state:string=run.startedAt?'running':'pending'; let waitingOn:unknown; let finishedAt:unknown;
      if(previousRun && ['completed','failed','cancelled','interrupted'].includes(String(previousRun.snapshot.state))) { snapshots.push(previousRun.snapshot); continue; }
      if(run.interruptedAt) {state='interrupted';finishedAt=run.interruptedAt;}
      else if(run.cancelledAt) {state='cancelled';finishedAt=run.cancelledAt;}
      else if(run.startedAt) {
        const waiting=result.snapshots.decisions.find(item=>item.ref.run_id===run.runId && item.state==='pending')??result.snapshots.toolApprovals.find(item=>item.ref.run_id===run.runId && item.state==='pending');
        if(waiting) {state=waiting.type==='decision'?'waiting_decision':'waiting_tool_approval'; waitingOn=waiting.ref;}
        else if(task.state==='waiting_reply') {state='waiting_reply';waitingOn=task.ref;}
        else if(['completed','review_ready'].includes(String(task.state))) {state='completed';finishedAt=previousRun?.snapshot.finished_at??now;}
        else if(task.state==='failed' || phase==='error') {state='failed';finishedAt=previousRun?.snapshot.finished_at??now;}
        else if(!phase || phase==='idle') {
          state='interrupted'; finishedAt=previousRun?.snapshot.finished_at??now;
        }
      }
      const body={contract_version:'1.0',type:'run',ref:{...run.taskRef,type:'run',run_id:run.runId},state,created_at:run.createdAt,
        ...(run.startedAt?{started_at:run.startedAt}:{}),...(waitingOn?{waiting_on:waitingOn}:{}),...(finishedAt?{finished_at:finishedAt}:{})};
      const fingerprint=stableJson(body); const changed=previousRun?.fingerprint!==fingerprint;
      const snapshot={...body,revision:changed?(previousRun?.revision??0)+1:previousRun.revision,updated_at:changed?now:previousRun.snapshot.updated_at} as Resource;
      nextRuns[run.runId]={fingerprint,revision:snapshot.revision,snapshot}; snapshots.push(snapshot);
    }
    return {snapshots,state:{desktop:result.state,runs:nextRuns,decisionEvidence:decisions,approvalEvidence:approvals} satisfies RuntimeProjectionState};
  }
  private async poll(kernel:PilotKernel,instanceId:string,signal:AbortSignal) {
    let failures=0;
    while(!signal.aborted && !isAppShutdownGateActive()) {
      try {
        await kernel.observe();
        await this.captureReviews(kernel);
        const response=await this.client.request('POST',`/instances/${encodeURIComponent(instanceId)}/deliveries/poll`,{transport_version:'1.0'},{authenticated:true,producer:true,signal});
        if(signal.aborted) break;
        if(response.status===204) {failures=0;continue;}
        const result=await kernel.handle(response.data);
        // A lost result is retried verbatim. Redelivery also consults the durable journal.
        for(let attempt=0;attempt<3 && !signal.aborted;attempt++) {
          try {await this.client.request('POST',`/instances/${encodeURIComponent(instanceId)}/deliveries/${encodeURIComponent(String(result.delivery_id))}/result`,result,{authenticated:true,producer:true,signal});break;}
          catch {if(attempt===2) throw new PilotError('unavailable');await pause(500*(attempt+1),signal);}
        }
        failures=0;
      } catch { if(signal.aborted) break; await pause(Math.min(1000*2**Math.min(failures++,5),30_000),signal); }
    }
  }
  private async captureReviews(kernel:PilotKernel) {
    const latestRuns = new Map<string, KnownRun>();
    for (const run of kernel.getKnownRuns()) {
      if (!run.startedAt || run.interruptedAt || run.cancelledAt) continue;
      const old = latestRuns.get(run.taskRef.task_id);
      if (!old?.startedAt || run.startedAt > old.startedAt) latestRuns.set(run.taskRef.task_id, run);
    }
    for(const run of latestRuns.values()) {
      const task=useTaskStore.getState().getTaskById(run.taskRef.task_id);
      if(!run.startedAt || task?.status!=='InReview') continue;
      for(const target of task.execution_targets??[]) {
        if(target.executionMode==='direct' || !target.repoPath || !target.targetBranchName) continue;
        const snapshot=await gitReviewSnapshot(target.repoPath);
        if(!snapshot.isClean || snapshot.mergeInProgress) continue;
        const branches=await gitBranchList(target.repoPath);
        const base=branches.local.find(branch=>branch.name===target.targetBranchName)?.commit;
        const head=branches.local.find(branch=>branch.name===target.branchName)?.commit;
        if(!base || !head || useTaskStore.getState().getTaskById(task.id)?.status!=='InReview') continue;
        const ref={...run.taskRef,type:'review',run_id:run.runId,project_id:target.projectId,review_id:await this.reviewId([run.runId,target.projectId,base,head])};
        await kernel.recordReview({contract_version:'1.0',type:'review',ref,related_run:{...run.taskRef,type:'run',run_id:run.runId},git_revision:{base_sha:base,head_sha:head},state:'pending',revision:1,updated_at:new Date().toISOString()});
      }
    }
  }
  private async reviewId(parts: string[]): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(parts)));
    return `review:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`;
  }
  private async validateReview(review: Resource): Promise<void> {
    const task = useTaskStore.getState().getTaskById(review.ref.task_id);
    const target = task?.execution_targets?.find(item => item.projectId === review.ref.project_id);
    if (task?.status !== 'InReview' || target?.executionMode === 'direct' || !target?.repoPath || !target.targetBranchName) throw new PilotError('stale_revision');
    const snapshot = await gitReviewSnapshot(target.repoPath);
    const branches = await gitBranchList(target.repoPath);
    const revision = object(review.git_revision);
    if (!snapshot.isClean || snapshot.mergeInProgress ||
        branches.local.find(branch => branch.name === target.branchName)?.commit !== revision.head_sha ||
        branches.local.find(branch => branch.name === target.targetBranchName)?.commit !== revision.base_sha ||
        useTaskStore.getState().getTaskById(task.id)?.status !== 'InReview') throw new PilotError('stale_revision');
  }
  getIndeterminate() { return this.kernel?.indeterminate()??[]; }
  async reconcileNotExecuted(key:string) { if(!this.kernel) throw new PilotError('unavailable');await this.kernel.reconcileNotExecuted(key); }
  async stop():Promise<void> {
    this.started=false;this.generation++;this.controller?.abort();this.kernel?.close();
    this.unsubscribers.splice(0).forEach(unsubscribe=>unsubscribe());
    const instance=this.client.getState().instance;
    if(instance && this.identity) {
      const timeout=AbortSignal.timeout(3000);
      try {await this.client.request('POST',`/instances/${encodeURIComponent(instance.ref.instance_id)}/disconnect`,{transport_version:'1.0'},{authenticated:true,producer:true,signal:timeout});} catch { /* Presence expires after the last producer poll. */ }
    }
    this.identity=null;this.kernel=null;
  }
}
export const macroPilotRuntime=new PilotRuntime();
