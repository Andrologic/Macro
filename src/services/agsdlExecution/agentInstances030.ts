import type { ExactJsonText } from './contracts';
import { clone, decode, encode, fail } from './exact';
import { monotoneMs030 } from './workIntegers030';

export type InstanceSelector030 = { readonly kind: 'shared' } | { readonly kind: 'named'; readonly name: string } | { readonly kind: 'new' };
export interface InstanceMemory030 {
  readonly agentInstanceId: string;
  readonly configurationDigest: string;
  readonly revision: string;
  readonly formatVersion: string;
  readonly stateJson: ExactJsonText;
}
export interface InstanceDelivery030 {
  readonly deliveryId: string;
  readonly workId: string;
  readonly senderId: string;
  readonly messageJson: ExactJsonText;
  readonly delivery?: 'queue' | 'steer';
}
export interface InstanceRecord030 {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly configurationDigest: string;
  readonly selector: InstanceSelector030;
  readonly memory: InstanceMemory030 | null;
}
export type InstanceDeliveryDecision030 = { readonly kind: 'start' | 'queued' | 'steer'; readonly instanceId: string; readonly workId: string };
interface Resident030 {
  record: InstanceRecord030;
  active: InstanceDelivery030 | null;
  countsForFlow: boolean;
  queue: InstanceDelivery030[];
}
/** Pure ownership/FIFO bookkeeping. Native still owns admission, scheduling and persistence. */
export class AgentInstances030 {
  private readonly instances = new Map<string, Resident030>();
  private readonly keys = new Map<string, string>();
  private readonly allocated = new Set<string>();
  private readonly deliveries = new Map<string, { signature: string; decision: InstanceDeliveryDecision030 }>();
  constructor(private readonly allocateId: () => string) {}
  resolve(definitionId: string, configurationDigest: string, selector: InstanceSelector030, delivery?: 'queue' | 'steer'): InstanceRecord030 {
    if (!definitionId.trim() || !configurationDigest.trim() || selector.kind === 'named' && !selector.name.trim()) fail('CORRELATION', '', 'Invalid instance identity.');
    if (selector.kind === 'new' && delivery !== undefined) fail('CORRELATION', '', 'A fresh instance cannot declare delivery.');
    const key = encode([definitionId, selector.kind, selector.kind === 'named' ? selector.name : '']);
    const existing = selector.kind === 'new' ? undefined : this.keys.get(key);
    if (existing) {
      const record = this.get(existing).record;
      if (record.configurationDigest !== configurationDigest) fail('CORRELATION', '', 'Instance configuration changed.');
      return clone(record);
    }
    const instanceId = this.allocateId();
    if (!instanceId.trim() || this.allocated.has(instanceId)) fail('CORRELATION', '', 'Instance allocator reused an identity.');
    this.allocated.add(instanceId);
    const record: InstanceRecord030 = { instanceId, definitionId, configurationDigest, selector: clone(selector), memory: null };
    this.instances.set(instanceId, { record, active: null, countsForFlow: true, queue: [] });
    if (selector.kind !== 'new') this.keys.set(key, instanceId);
    return clone(record);
  }
  deliver(instanceId: string, input: InstanceDelivery030): InstanceDeliveryDecision030 {
    const resident = this.get(instanceId);
    if (![input.deliveryId, input.workId, input.senderId].every(value => value.trim())) fail('CORRELATION', '', 'Delivery identities must be nonempty.');
    decode(input.messageJson);
    const signature = encode({ instanceId, ...input });
    const prior = this.deliveries.get(input.deliveryId);
    if (prior) {
      if (prior.signature !== signature) fail('CORRELATION', '', 'Delivery identity has conflicting content.');
      return clone(prior.decision);
    }
    if (resident.record.selector.kind === 'new' && (resident.active || input.delivery !== undefined)) fail('CORRELATION', '', 'Fresh instances own exactly one work and no delivery policy.');
    const kind = resident.active === null ? 'start' : input.delivery === 'steer' && resident.countsForFlow ? 'steer' : 'queued';
    const decision: InstanceDeliveryDecision030 = { kind, instanceId, workId: kind === 'steer' ? resident.active!.workId : input.workId };
    if (kind === 'start') { resident.active = clone(input); resident.countsForFlow = true; }
    if (kind === 'queued') resident.queue.push(clone(input));
    this.deliveries.set(input.deliveryId, { signature, decision });
    return clone(decision);
  }
  setCountsForFlow(instanceId: string, workId: string, value: boolean): void {
    const resident = this.get(instanceId);
    if (resident.active?.workId !== workId) fail('CORRELATION', '', 'Foreign active work.');
    resident.countsForFlow = value;
  }
  finish(instanceId: string, workId: string, memory?: InstanceMemory030): InstanceDelivery030 | null {
    const resident = this.get(instanceId);
    if (resident.active?.workId !== workId) fail('CORRELATION', '', 'Only the active work can finish.');
    if (memory) {
      if (memory.agentInstanceId !== instanceId || memory.configurationDigest !== resident.record.configurationDigest || !memory.formatVersion.trim()) fail('CORRELATION', '', 'Foreign memory checkpoint.');
      const revision = monotoneMs030(memory.revision);
      if (revision <= monotoneMs030(resident.record.memory?.revision ?? '0')) fail('CORRELATION', '', 'Memory revision must advance.');
      decode(memory.stateJson);
      resident.record = { ...resident.record, memory: clone(memory) };
    }
    if (resident.record.selector.kind === 'new') { this.instances.delete(instanceId); return null; }
    resident.active = resident.queue.shift() ?? null;
    resident.countsForFlow = true;
    return clone(resident.active);
  }
  inspect(instanceId: string): InstanceRecord030 { return clone(this.get(instanceId).record); }
  private get(instanceId: string): Resident030 {
    const resident = this.instances.get(instanceId);
    if (!resident) fail('CORRELATION', '', 'Unknown or discarded instance.');
    return resident;
  }
}
