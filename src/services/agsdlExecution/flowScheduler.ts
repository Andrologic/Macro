import type { EngineActivation, EngineOwner, EngineTerminalCommit, EngineWork, HostAdmission, HostInspection, Prepare } from '../../types/generated/ipc';
import * as ipc from '../ipc/agsdlExecution';
import { executeFlowActivation, loadFlowCapture, resolveFlowVisitLimit, type FlowAgent, type FlowCapture } from './flowActivation';
import { decode, fail, record, text } from './exact';
import { compareSequence } from './invariants';
import type { Sequence } from './contracts';

export interface FlowSchedulerPorts {
  owners(): Promise<EngineOwner[]>;
  inspect(owner: EngineOwner): Promise<HostInspection>;
  begin(owner: EngineOwner, deliveryId: string): Promise<HostAdmission>;
  prepare(request: Prepare): Promise<string>;
  commit(owner: EngineOwner, witnessId: string): Promise<EngineTerminalCommit>;
  uncertain(owner: EngineOwner, work: EngineWork, reason: string): Promise<void>;
  load(inspection: HostInspection): Promise<FlowCapture>;
  execute: typeof executeFlowActivation;
  visitLimit: typeof resolveFlowVisitLimit;
  yield(): Promise<void>;
}
export const nativeFlowSchedulerPorts: FlowSchedulerPorts = {
  owners: ipc.executionHostOwners, inspect: ipc.executionHostInspect, begin: ipc.executionHostBegin,
  prepare: ipc.executionHostPrepareTerminal, commit: ipc.executionHostCommitTerminal, uncertain: ipc.executionHostMarkUncertain,
  load: loadFlowCapture, execute: executeFlowActivation, visitLimit: resolveFlowVisitLimit,
  yield: () => new Promise(resolve => setTimeout(resolve, 0)),
};
function sameOwner(left: EngineOwner, right: EngineOwner): boolean {
  return left.systemStartId === right.systemStartId && left.ownerEpoch === right.ownerEpoch;
}
function sameWork(left: EngineWork, right: EngineWork): boolean {
  return left.systemStartId === right.systemStartId && left.activationId === right.activationId && left.flowInvocationId === right.flowInvocationId
    && left.agentInstanceId === right.agentInstanceId && JSON.stringify(left.step) === JSON.stringify(right.step);
}
function stopped(inspection: HostInspection, work: EngineWork): boolean {
  const activation = inspection.projection.activations.find(item => sameWork(item.delivery.work, work));
  return inspection.projection.systemStop.kind !== 'none' || activation === undefined || activation.stopState.kind !== 'none';
}
interface Finishing { request?: Prepare; witnessId?: string }
/** One disposable pump per native system/owner in this host generation. SQL owns
 * the queue and every durable boundary; this object retains only its continuations. */
export class FlowPump {
  private running: Promise<void> | undefined;
  private dirty = false;
  private retired = false;
  private capture: FlowCapture | undefined;
  private snapshotDigest: string | undefined;
  private agent: FlowAgent | undefined;
  private currentWork: EngineWork | undefined;
  private stopObserved = false;
  private finishing: Finishing | undefined;
  private lostAdmission: EngineActivation | undefined;
  private uncertain: { work: EngineWork; reason: string } | undefined;
  /** Diagnostic only. It never becomes an ErrorInput or a successor. */
  lastError: unknown;
  constructor(readonly generation: string, readonly owner: EngineOwner, private readonly ports = nativeFlowSchedulerPorts) {}

  /** The supervisor calls this even while begin/execute/commit is awaiting IO. */
  observe(inspection: HostInspection): void {
    if (this.currentWork && stopped(inspection, this.currentWork)) {
      this.stopObserved = true;
      this.agent?.requestStop();
    }
  }
  retire(): void { this.retired = true; this.agent?.requestStop(); }
  wake(): Promise<void> {
    if (this.retired) return Promise.resolve();
    this.dirty = true;
    if (!this.running) {
      this.running = this.drain().catch(error => { this.lastError = error; }).finally(() => {
        // Release and recheck synchronously, including a wake arriving at exit.
        this.running = undefined;
        if (this.dirty && !this.retired) void this.wake();
      });
    }
    return this.running;
  }
  private async finish(): Promise<boolean> {
    const pending = this.finishing!;
    try {
      if (!pending.witnessId) pending.witnessId = await this.ports.prepare(pending.request!);
      if (this.retired) return false;
      const receipt = await this.ports.commit(this.owner, pending.witnessId);
      if (pending.request && (!sameOwner(receipt.owner, this.owner) || !sameWork(receipt.work, pending.request.work))) {
        fail('CORRELATION', '/terminal', 'Terminal acknowledgement belongs to another work.');
      }
      this.finishing = undefined;
      return true;
    } catch (error) {
      // Keep this exact no-effect operation, never execute the activation again.
      // The next native read/retransmission finds the first witness and final receipt.
      this.lastError = error;
      return false;
    }
  }
  private retainedWitness(inspection: HostInspection): string | undefined {
    for (const raw of inspection.preparedTerminalsJson) {
      const retained = record(decode(raw));
      if (retained.generation !== this.generation || retained.final_commit !== null) continue;
      const request = record(retained.request), owner = record(request.owner), work = record(request.work);
      if (owner.systemStartId !== this.owner.systemStartId || owner.ownerEpoch !== this.owner.ownerEpoch) continue;
      const activation = inspection.projection.activations.find(item => item.delivery.work.activationId === work.activationId);
      // An old generation or an uncertain work is reconciled by native recovery,
      // never adopted by the JS pump merely because a witness was retained.
      if (activation?.workState === 'active') return text(retained.id);
    }
  }
  private async drain(): Promise<void> {
    let budget = 0;
    while (!this.retired) {
      if (++budget === 32) { budget = 0; await this.ports.yield(); }
      this.dirty = false;
      if (this.uncertain) {
        try {
          await this.ports.uncertain(this.owner, this.uncertain.work, this.uncertain.reason);
          this.uncertain = undefined;
        } catch (error) { this.lastError = error; return; }
      }
      if (this.finishing && !await this.finish()) return;
      const inspection = await this.ports.inspect(this.owner);
      this.observe(inspection);
      if (inspection.snapshot.systemStartId !== this.owner.systemStartId || inspection.projection.systemStartId !== this.owner.systemStartId) {
        fail('CORRELATION', '/owner', 'Private inspection belongs to another system.');
      }
      if (this.snapshotDigest && this.snapshotDigest !== inspection.snapshotDigest) fail('CORRELATION', '/snapshot', 'Native snapshot changed within a system.');
      if (!this.capture) { this.capture = await this.ports.load(inspection); this.snapshotDigest = inspection.snapshotDigest; }
      if (this.retired) return;
      const witnessId = this.retainedWitness(inspection);
      if (witnessId) {
        this.finishing = { witnessId };
        continue;
      }
      // An active work without our continuation or a prepared native witness is
      // not a redispatch candidate, even if no effect is currently visible.
      let selected: EngineActivation | undefined;
      let admission: HostAdmission | undefined;
      if (this.lostAdmission) {
        const retained = inspection.projection.activations.find(item => item.delivery.deliveryId === this.lostAdmission!.delivery.deliveryId);
        if (retained?.workState === 'active') {
          try { admission = await this.ports.begin(this.owner, retained.delivery.deliveryId); }
          catch (error) { this.lastError = error; return; }
          if (admission.kind === 'waiting' && admission.reason === 'active' && retained.admittedEpoch === this.owner.ownerEpoch
            && sameWork(retained.delivery.work, this.lostAdmission.delivery.work)
            && retained.delivery.input.origin === this.lostAdmission.delivery.input.origin
            && retained.delivery.input.valueJson === this.lostAdmission.delivery.input.valueJson
            && !inspection.effects.some(effect => sameWork(effect.registered.context.work, retained.delivery.work))) {
            // This generation still owns the pre-dispatch continuation. A repeated
            // begin distinguishes a reserved VISIT_LIMIT from an ordinary admission.
            admission = { kind: 'admitted', activation: retained, memory: inspection.agents.find(agent => agent.agentInstanceId === retained.delivery.work.agentInstanceId)?.memory ?? null };
          }
          if (admission.kind === 'admitted' || admission.kind === 'rejected' && admission.code === 'VISIT_LIMIT') selected = retained;
        }
        this.lostAdmission = undefined;
      }
      const orphan = inspection.projection.activations.find(item => item.workState === 'active' && item !== selected);
      if (orphan) {
        this.uncertain = { work: orphan.delivery.work, reason: 'Resident continuation is unavailable; work cannot be redispatched.' };
        continue;
      }
      if (inspection.projection.systemStop.kind !== 'none') return;
      const candidates = inspection.projection.activations.filter(item => item.workState === 'queued' && item.stopState.kind === 'none')
        .sort((a, b) => compareSequence(a.delivery.queueSequence as Sequence, b.delivery.queueSequence as Sequence));
      for (const candidate of selected ? [] : candidates) {
        try { admission = await this.ports.begin(this.owner, candidate.delivery.deliveryId); }
        catch (error) {
          // Admission ack lost: we have no proof allowing an effect. Native
          // reinspection will retain queued work or classify its lost continuation.
          this.lastError = error;
          this.lostAdmission = candidate;
          return;
        }
        if (admission.kind === 'admitted' || admission.kind === 'rejected' && admission.code === 'VISIT_LIMIT') {
          selected = candidate;
          break;
        }
      }
      if (!selected || !admission) {
        if (this.dirty) continue;
        return;
      }
      if (this.retired) return;
      this.currentWork = selected.delivery.work;
      this.stopObserved = false;
      try {
        let request: Prepare;
        if (admission.kind === 'admitted') {
          if (!sameWork(admission.activation.delivery.work, selected.delivery.work)
            || admission.activation.delivery.deliveryId !== selected.delivery.deliveryId) fail('CORRELATION', '/admission', 'Admission belongs to another candidate.');
          request = await this.ports.execute(this.owner, admission.activation, admission.memory, inspection, this.capture, agent => {
            this.agent = agent;
            if (this.stopObserved || this.retired) agent.requestStop();
          });
        } else request = await this.ports.visitLimit(this.owner, selected, inspection, this.capture);
        this.finishing = { request };
      } catch (error) {
        this.lastError = error;
        // Bounded phase-only reason; exception payloads may contain private data.
        this.uncertain = { work: selected.delivery.work, reason: 'Resident activation lacks a confirmed terminal boundary; no continuation dispatched.' };
      } finally {
        this.agent = undefined;
        this.currentWork = undefined;
      }
    }
  }
}

/** Polling is bounded in frequency and coalesced. It reads Stop independently of
 * the pumps and never waits for Agent work, approvals or the compiler mailbox. */
export class ResidentFlowHost {
  private readonly pumps = new Map<string, FlowPump>();
  private polling: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(readonly generation: string, private readonly ports = nativeFlowSchedulerPorts, private readonly intervalMs = 150) {
    if (!Number.isInteger(intervalMs) || intervalMs < 50) fail('UNSUPPORTED', '/polling', 'Resident polling requires a bounded positive interval.');
  }
  start(): void {
    if (this.closed || this.timer || this.polling) return;
    const tick = () => {
      this.timer = undefined;
      void this.poll().catch(() => undefined).finally(() => { if (!this.closed) this.timer = setTimeout(tick, this.intervalMs); });
    };
    tick();
  }
  wake(owner?: EngineOwner): void {
    if (this.closed) return;
    const pump = owner && this.pumps.get(owner.systemStartId);
    if (pump && sameOwner(pump.owner, owner!)) void pump.wake();
    else void this.poll().catch(() => undefined);
  }
  poll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.polling) this.polling = this.inspectOwners().finally(() => { this.polling = undefined; });
    return this.polling;
  }
  private async inspectOwners(): Promise<void> {
    const owners = await this.ports.owners();
    if (this.closed) return;
    const present = new Set(owners.map(owner => owner.systemStartId));
    for (const [id, pump] of this.pumps) if (!present.has(id)) { pump.retire(); this.pumps.delete(id); }
    for (const owner of owners) {
      let pump = this.pumps.get(owner.systemStartId);
      if (pump && !sameOwner(pump.owner, owner)) { pump.retire(); this.pumps.delete(owner.systemStartId); pump = undefined; }
      if (!pump) { pump = new FlowPump(this.generation, owner, this.ports); this.pumps.set(owner.systemStartId, pump); }
      try {
        const inspection = await this.ports.inspect(owner);
        if (this.closed) return;
        pump.observe(inspection);
        void pump.wake();
      } catch (error) {
        // A failed read does not establish owner loss. Preserve the current
        // continuation; only the next successful owners read can retire it.
        pump.lastError = error;
      }
    }
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const pump of this.pumps.values()) pump.retire();
    this.pumps.clear();
  }
}
