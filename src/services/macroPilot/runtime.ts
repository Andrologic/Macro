import { taskActionPermissions, assertTaskActionPermissions } from './taskActionAuthorization';
import { TASK_COMPLETION_CAPABILITIES } from './taskCompletionHost';
import { findPilotTask, pilotTaskId, resolvePilotTask, resolvePilotStartTask } from './taskIdentity';
import { createDesktopContentHost } from './desktopContentHost';
import type { ContentHost } from './contentHost';
import type { ContentDelivery } from './contentProtocol';
import type { DesktopStorePorts } from './desktopStorePorts';
import { isAppShutdownGateActive } from '../appShutdownGate';
import { frontendLog, gitBranchList, gitReviewSnapshot } from '../tauriIpc';
import { createDesktopActions, type DesktopActions, type DesktopToolApprovalPayload } from './desktopActions';
import { PilotKernel, type KernelDependencies, type KnownRun } from './kernel';
import { macroPilotNativeClient, type MacroPilotNativeClient } from './nativeClient';
import { ProjectionError, projectDesktopSnapshots, toolApprovalSourceKey, type LocalResolutionEvidence, type ProjectionState, type ToolApprovalResolutionEvidence } from './projection';
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

export type PilotRuntimeStatus = 'inactive' | 'running' | 'unavailable';
export class PilotRuntime {
  private status: PilotRuntimeStatus = 'inactive';
  private readonly listeners = new Set<() => void>();
  getStatus() { return this.status; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(status: PilotRuntimeStatus) { this.status = status; this.listeners.forEach(listener => listener()); }
  async retry() { this.identity = null; if (!this.started) await this.start(); else await this.synchronize(); }
  private kernel: PilotKernel | null = null;
  private content: ContentHost | null = null;
  private controller: AbortController | null = null;
  private identity: string | null = null;
  private generation = 0;
  private started = false;
  private stopping: Promise<void> | null = null;
  isStarted() { return this.started; }
  private unsubscribers: Array<()=>void> = [];
  private localRuns = new Set<string>();
  private decisionEvidence: Record<string, LocalResolutionEvidence> = {};
  private approvalEvidence: Record<string, ToolApprovalResolutionEvidence> = {};
  private approvalObservedAt: Record<string, string> = {};
  private activeLoop: Promise<void> | null = null;
  private readonly actions: DesktopActions;
  constructor(
    private readonly client: Pick<MacroPilotNativeClient, 'getState' | 'subscribe' | 'initialize' | 'request'> & Partial<Pick<MacroPilotNativeClient, 'requestContent' | 'contentSecretValues'>> = macroPilotNativeClient,
    private readonly createKernel: (dependencies: KernelDependencies) => PilotKernel = dependencies => new PilotKernel(dependencies),
    private readonly ports: DesktopStorePorts,
  ) {
    this.actions = createDesktopActions(ports);
  }
  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.started) return;
    const generation = this.generation;
    if (isAppShutdownGateActive()) { this.publish('unavailable'); return; }
    const producerStopped = await this.waitForProducer();
    if (this.started || generation !== this.generation) return;
    if (!producerStopped) { this.publish('unavailable'); return; }
    if (isAppShutdownGateActive()) { this.publish('unavailable'); return; }
    this.started=true;
    this.unsubscribers.push(this.client.subscribe(()=>{void this.synchronize();}));
    try {
      await this.client.initialize();
      if (this.started && generation === this.generation) await this.synchronize();
    } catch { if (this.started && generation === this.generation) this.publish('unavailable'); }
  }
  private async synchronize() {
    const state=this.client.getState();
    const instanceId=state.instance?.ref.instance_id;
    const next=['connected','offline'].includes(state.status) && state.configurationId && instanceId && state.deviceSession?.state==='active'
      ? stableJson([state.configurationId,state.relayOrigin,state.account?.account_id,instanceId,state.deviceSession.ref.session_id]) : null;
    if (next===this.identity || !this.started) return;
    this.generation++; const generation=this.generation;
    this.controller?.abort(); this.kernel?.close(); this.kernel=null;
    const disposing = this.content?.dispose(); this.content=null;
    void disposing?.catch(() => undefined);
    this.identity=next;
    if (!next || !instanceId || !state.configurationId) { this.publish('inactive'); return; }
    // A previous loop must stop before this instance starts another producer poll.
    await this.activeLoop?.catch(()=>undefined);
    await disposing?.catch(()=>undefined);
    if (generation!==this.generation) return;
    const controller=new AbortController(); this.controller=controller;
    const authorize=async (delivery: {delivery_id:string}) => {
      if(controller.signal.aborted || isAppShutdownGateActive()) throw new PilotError('unavailable');
      const response=await this.client.request('POST',`/instances/${encodeURIComponent(instanceId)}/deliveries/${encodeURIComponent(delivery.delivery_id)}/authorize`,{transport_version:'1.0'},{authenticated:true,producer:true,signal:controller.signal});
      const deadline=object(response.data).execute_before;
      if(typeof deadline!=='string') throw new PilotError('unavailable'); return deadline;
    };
    let initializationStage = "storage.load";
    const storage = pilotKernelStorage(state.configurationId, instanceId);
    const kernel: PilotKernel=this.createKernel({
      instanceId,storage: {
        load: () => { initializationStage = 'storage.load'; return storage.load(); },
        compareAndSwap: (previous, next) => { initializationStage = 'storage.save'; return storage.compareAndSwap(previous, next); },
      },
      project:(previous,now,runs)=> { initializationStage = 'projection'; return this.project(previous,now,runs,instanceId,state.configurationId!); },
      authorize,
      validateReview: review => this.validateReview(review),
      validateConversationSend: async command => {
        if (!this.content?.isAvailable()) throw new PilotError('unavailable');
        try {
          await this.content.validateConversationSendTarget({ instance_id: command.target.instance_id, kind: 'conversation', conversation_id: command.target.conversation_id }, command.expected_revision);
        } catch (error) {
          throw new PilotError(error instanceof Error && ['stale_revision', 'invalid_reference'].includes(error.message) ? error.message as 'stale_revision' | 'invalid_reference' : 'unavailable');
        }
      },
      execute:async(command,guard)=>{
        if (isAppShutdownGateActive()) throw new PilotError('unavailable');
        if(command.kind==='run.start') {
          const result=await this.actions.start(resolvePilotStartTask(this.ports.tasks().tasks, command.target.task_id).id,guard);
          this.localRuns.add(String(command.payload.run_id)); return result;
        }
        if(command.kind==='conversation.send') return this.actions.sendConversation(command.target.conversation_id,String(command.payload.content),guard);
        if(command.kind==='task.reply') return this.actions.reply(resolvePilotTask(this.ports.tasks().tasks, command.target.task_id).id,String(command.payload.conversation_id),String(command.payload.answer),guard);
        if(command.kind==='decision.resolve') {
          await this.actions.answerDecision(this.decisionRef(command),command.payload.answers as Array<{step_id:string;answer:string}>,guard);
          this.decisionEvidence[command.target.assistant_message_id]={resolvedAt:new Date().toISOString(),resolvedBy:command.issued_by}; return;
        }
        if(command.kind==='tool_approval.resolve') {
          const ref={conversation_id:command.target.conversation_id,assistant_message_id:command.target.assistant_message_id,tool_call_id:command.target.tool_call_id};
          await this.actions.resolveApproval(ref,command.payload as DesktopToolApprovalPayload,guard);
          const key=toolApprovalSourceKey({conversationId:ref.conversation_id,assistantMessageId:ref.assistant_message_id,toolCallId:ref.tool_call_id});
          this.approvalEvidence[key]={verdict:command.payload.verdict as 'approve'|'deny',
            ...(command.payload.grant_scope?{grantScope:command.payload.grant_scope as 'once'|'conversation'}:{}),
            ...(command.payload.reason?{reason:String(command.payload.reason)}:{}),resolvedAt:new Date().toISOString(),resolvedBy:command.issued_by}; return;
        }
        if(command.kind==='run.cancel') {
          const bound=kernel.getKnownRuns().find(run=>run.runId===command.target.run_id && run.taskRef.task_id===command.target.task_id && run.taskRef.workspace_id===command.target.workspace_id);
          if(!bound?.conversationId) throw new PilotError('invalid_reference');
          return this.actions.cancel(bound.conversationId,guard);
        }
        throw new PilotError('validation_failed');
      },
    });
    try {
      await kernel.initialize(); if(generation!==this.generation) {kernel.close(); return;}
      this.kernel=kernel; this.publish('running');
      this.activeLoop = this.runProducer(kernel, instanceId, state.configurationId, state.account?.account_id, controller.signal).catch(() => undefined);
    } catch (error) {
      void frontendLog({ level: 'error', scope: 'frontend', message: `[Frontend:Pilot${initializationStage.replace(/[^a-z]/gi, '')}${error instanceof ProjectionError ? error.reason : error instanceof PilotError ? error.code.replaceAll('_', '') : error instanceof TypeError ? 'TypeError' : 'UnknownError'}]` }).catch(() => undefined);
      controller.abort();
      if (generation === this.generation) { this.identity=null; this.publish('unavailable'); }
    }
  }
  private async runProducer(kernel: PilotKernel, instanceId: string, configurationId: string, accountId: string | undefined, signal: AbortSignal) {
    if (accountId && this.client.requestContent && this.client.contentSecretValues) {
      // Fence a previous producer incarnation before either new poll advertises
      // availability, including restart after a crash without a graceful stop.
      // This existing transport reset replaces synthetic baseline change events.
      while (!signal.aborted && !isAppShutdownGateActive()) {
        try {
          const response = await this.client.request('POST', `/instances/${encodeURIComponent(instanceId)}/disconnect`, { transport_version: '1.0' },
            { authenticated: true, producer: true, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
          if (response.status !== 204) throw new PilotError('unavailable');
          break;
        } catch {
          if (signal.aborted) return;
          this.publish('unavailable'); await pause(1000, signal);
        }
      }
      if (signal.aborted || isAppShutdownGateActive()) return;
    }
    const v1 = this.poll(kernel, instanceId, signal);
    const v2 = (async () => {
      if (!accountId || !this.client.requestContent || !this.client.contentSecretValues) return;
      const host = createDesktopContentHost({ configurationId, instanceId, accountId, signal, kernel, ports: this.ports,
        transportSecrets: () => this.client.contentSecretValues!() });
      this.content = host;
      try {
        // Failed capability/policy/storage initialization leaves ACCOUNT and v1 alive.
        await host.initialize();
        // Establish the export policy before the first capability-announcing poll.
        await host.prepare();
        if (signal.aborted) return;
        await Promise.all([this.pollContent(host, instanceId, signal), this.observeContent(host, instanceId, signal)]);
      } catch { /* No v2 poll advertises a host that failed initialization. */ }
      finally { await host.dispose().catch(() => undefined); if (this.content === host) this.content = null; }
    })();
    await Promise.allSettled([v1, v2]);
  }
  private async observeContent(host: ContentHost, instanceId: string, signal: AbortSignal) {
    while (!signal.aborted && host.isAvailable() && !isAppShutdownGateActive()) {
      try {
        await host.observe();
      } catch { if (!signal.aborted) this.publish('unavailable'); }
      try {
        await host.flush(async event => {
          if (signal.aborted) throw new PilotError('unavailable');
          await this.client.requestContent!(`/pilot/v2/instances/${encodeURIComponent(instanceId)}/deliveries/events`, event, signal);
        });
      } catch { if (!signal.aborted) this.publish('unavailable'); }
      await pause(1000, signal);
    }
  }
  private async pollContent(host: ContentHost, instanceId: string, signal: AbortSignal) {
    const base = `/pilot/v2/instances/${encodeURIComponent(instanceId)}/deliveries`;
    let failures = 0;
    let extended = true;
    while (!signal.aborted && host.isAvailable() && !isAppShutdownGateActive()) {
      try {
        const response = await this.client.requestContent!(`${base}/poll`, { transport_version: '2.0', type: 'poll', commands: ['conversation.send'], ...(extended ? { capabilities: [...TASK_COMPLETION_CAPABILITIES] } : {}) }, signal);
        if (signal.aborted) break;
        if (response.status === 204) { failures = 0; await pause(25, signal); continue; }
        let executeBefore = 0;
        const result = await host.handle(response.data, async (delivery: ContentDelivery) => {
          if (signal.aborted) throw new PilotError('unavailable');
          const requiredPermissions = taskActionPermissions(delivery.request);
          const authorization = await this.client.requestContent!(`${base}/${encodeURIComponent(delivery.request_id)}/authorize`,
            { transport_version: '2.0', type: 'authorize', request_id: delivery.request_id, ...(requiredPermissions ? { required_permissions: requiredPermissions } : {}) }, signal);
          const data = object(authorization.data);
          if (signal.aborted || data.type !== 'authorized' || data.request_id !== delivery.request_id || typeof data.execute_before !== 'string') throw new PilotError('unavailable');
          assertTaskActionPermissions(requiredPermissions, data);
          executeBefore = Date.parse(data.execute_before);
          return data.execute_before;
        });
        for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
          try {
            // The native transport checks account/session/instance again at emission;
            // D validates the delivery authorization before accepting this result.
            if (signal.aborted || Date.now() >= executeBefore) throw new PilotError('unavailable');
            await this.client.requestContent!(`${base}/${encodeURIComponent(result.request_id)}/result`, result, signal); break;
          } catch { if (attempt === 2) throw new PilotError('unavailable'); await pause(500 * (attempt + 1), signal); }
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        const status = object(error).status;
        if (extended && (status === 400 || status === 422)) { extended = false; continue; }
        this.publish('unavailable'); await pause(Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000), signal);
      }
    }
  }
  private decisionRef(command:Command) {
    if(!command.target.conversation_id || !command.target.assistant_message_id) throw new PilotError('invalid_reference');
    return {conversation_id:command.target.conversation_id,assistant_message_id:command.target.assistant_message_id,task_id:resolvePilotTask(this.ports.tasks().tasks, command.target.task_id).id};
  }
  private project(previous:unknown,now:string,runs:KnownRun[],instanceId:string,configurationId:string) {
    const persisted=previous ? previous as RuntimeProjectionState : emptyProjection();
    const app=this.ports.app(); const chat=this.ports.chat(); const tasks=this.ports.tasks().tasks;
    const projects=[...new Map([...app.standaloneProjects,...app.projectGroups.flatMap(group=>group.projects)].map(project=>[project.id,project])).values()];
    const knownRuns=runs.filter((run): run is KnownRun & { startedAt: string } => Boolean(run.startedAt)).map(run=>({taskId:run.taskRef.task_id,runId:run.runId,startedAt:run.startedAt,finishedAt:persisted.runs[run.runId]?.snapshot.finished_at as string | undefined}));
    const decisions={...persisted.decisionEvidence,...this.decisionEvidence}; const approvals={...persisted.approvalEvidence,...this.approvalEvidence};
    for (const approval of Object.values(chat.pendingToolApprovalByConversationId)) {
      if (!approval || approval.recoveryState === 'interrupted') continue;
      const conversation = chat.conversations.find(item => item.id === approval.conversationId);
      if (!runs.some(run => this.localRuns.has(run.runId) && run.taskRef.task_id === (conversation?.task_id ? pilotTaskId(conversation.task_id) : undefined))) continue;
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
        if (signal.aborted) break;
        await this.captureReviews(kernel);
        if (signal.aborted) break;
        const response=await this.client.request('POST',`/instances/${encodeURIComponent(instanceId)}/deliveries/poll`,{transport_version:'1.0'},{authenticated:true,producer:true,signal});
        if(signal.aborted) break;
        if(response.status===204) {failures=0;this.publish('running');continue;}
        const result=await kernel.handle(response.data);
        if (signal.aborted) break;
        // A lost result is retried verbatim. Redelivery also consults the durable journal.
        for(let attempt=0;attempt<3 && !signal.aborted;attempt++) {
          try {await this.client.request('POST',`/instances/${encodeURIComponent(instanceId)}/deliveries/${encodeURIComponent(String(result.delivery_id))}/result`,result,{authenticated:true,producer:true,signal});break;}
          catch {if(attempt===2) throw new PilotError('unavailable');await pause(500*(attempt+1),signal);}
        }
        if (signal.aborted) break;
        failures=0; this.publish('running');
      } catch { if(signal.aborted) break; this.publish('unavailable'); await pause(Math.min(1000*2**Math.min(failures++,5),30_000),signal); }
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
      const task=findPilotTask(this.ports.tasks().tasks, run.taskRef.task_id);
      if(!run.startedAt || task?.status!=='InReview') continue;
      for(const target of task.execution_targets??[]) {
        if(target.executionMode==='direct' || !target.repoPath || !target.targetBranchName) continue;
        const snapshot=await gitReviewSnapshot(target.repoPath);
        if(!snapshot.isClean || snapshot.mergeInProgress) continue;
        const branches=await gitBranchList(target.repoPath);
        const base=branches.local.find(branch=>branch.name===target.targetBranchName)?.commit;
        const head=branches.local.find(branch=>branch.name===target.branchName)?.commit;
        if(!base || !head || this.ports.tasks().getTaskById(task.id)?.status!=='InReview') continue;
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
    const task = findPilotTask(this.ports.tasks().tasks, review.ref.task_id);
    const target = task?.execution_targets?.find(item => item.projectId === review.ref.project_id);
    if (task?.status !== 'InReview' || target?.executionMode === 'direct' || !target?.repoPath || !target.targetBranchName) throw new PilotError('stale_revision');
    const snapshot = await gitReviewSnapshot(target.repoPath);
    const branches = await gitBranchList(target.repoPath);
    const revision = object(review.git_revision);
    if (!snapshot.isClean || snapshot.mergeInProgress ||
        branches.local.find(branch => branch.name === target.branchName)?.commit !== revision.head_sha ||
        branches.local.find(branch => branch.name === target.targetBranchName)?.commit !== revision.base_sha ||
        this.ports.tasks().getTaskById(task.id)?.status !== 'InReview') throw new PilotError('stale_revision');
  }
  getIndeterminate() { return this.kernel?.indeterminate()??[]; }
  async reconcileNotExecuted(key:string) { if(!this.kernel) throw new PilotError('unavailable');await this.kernel.reconcileNotExecuted(key); }
  private async waitForProducer(): Promise<boolean> {
    if (!this.activeLoop) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.activeLoop.then(() => true, () => true),
        new Promise<boolean>(resolve => { timer=setTimeout(() => resolve(false), 3000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.started=false;this.generation++;this.controller?.abort();this.kernel?.close();
    const disposing = this.content?.dispose(); this.content=null;
    void disposing?.catch(() => undefined);
    this.unsubscribers.splice(0).forEach(unsubscribe=>unsubscribe());
    const instance=this.client.getState().instance;
    const identity=this.identity;
    this.identity=null;this.kernel=null;this.publish('inactive');
    this.stopping = (async () => {
      await disposing?.catch(() => undefined);
      // A transport that ignores cancellation must not block app shutdown forever.
      // start() will fence a later producer until this loop has actually stopped.
      const producerStopped = await this.waitForProducer();
      if (!producerStopped) return;
      // All old producers have stopped before presence is disconnected.
      if(instance && identity) {
        const timeout=AbortSignal.timeout(3000);
        try {await this.client.request('POST',`/instances/${encodeURIComponent(instance.ref.instance_id)}/disconnect`,{transport_version:'1.0'},{authenticated:true,producer:true,signal:timeout});} catch { /* Presence expires after the last producer poll. */ }
      }
    })().finally(() => { this.stopping=null; });
    return this.stopping;
  }
}
