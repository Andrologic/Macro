import type { ContentConversationRef, ContentDelivery, ContentReflections, ContentReflectionFragment } from './contentProtocol';
import { controlledText, type TextPolicy, utf8Bytes } from './conversationText';
import { stableJson } from './protocol';

export const REFLECTION_CAPABILITY = 'conversation-reflections-1';
export const REFLECTION_OPERATION = 'conversation.reflections.read';
export const REFLECTION_LIMITS = { sourceBytes: 1024 * 1024, blocks: 128, fragmentBytes: 8192, pageFragments: 8,
  workBytes: 16 * 1024 * 1024, instanceBytes: 32 * 1024 * 1024, sessionBytes: 16 * 1024 * 1024,
  instanceCaptures: 32, sessionCaptures: 16, historyLifetime: 300000, activeLifetime: 15000 } as const;
export interface ReflectionObservation {
  content: string;
  metadata: string;
  blocks: Array<{ content: string; partial: boolean }>;
  turnId: string | null;
  source: 'history' | 'active';
  /** Opaque generation identity, never a provider field. */
  generationId: string | null;
  state?: 'withheld' | 'too_large' | 'unavailable';
}
export interface ReflectionSource {
  available(): boolean;
  /** Checks the full current desktop target without hydrating history. */
  validateTarget(ref: ContentConversationRef): Promise<void>;
  /** Minimal native history or the existing visible active assistant. */
  observe(ref: ContentConversationRef, messageId: string): Promise<ReflectionObservation>;
}
interface Capture {
  binding: string; session: string; bytes: number; sourceContent: string; metadata: string;
  result: ContentReflections; fragments: ContentReflectionFragment[]; cursors: Map<string, number>;
}
const fail = (code: string): never => { throw new Error(code); };
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const safeWhole = (observation: ReflectionObservation, policy: TextPolicy): boolean => {
  // Concatenation also detects a configured secret split between visible blocks.
  const text = observation.blocks.map(block => block.content).join('');
  return controlledText(text, { ...policy, inspectionBytes: REFLECTION_LIMITS.sourceBytes }, REFLECTION_LIMITS.sourceBytes).content_state === 'complete';
};

/** RAM-only captures. Caller owns network authorization and final transport fence. */
export class ConversationReflections {
  private enabled = false;
  private revision = 0;
  private captures = new Map<string, Capture>();
  private work = false;
  constructor(private readonly source: ReflectionSource, private readonly now = Date.now) {}
  available(): boolean { return this.source.available(); }
  enable(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.clear(); }
  clear(): void { this.captures.clear(); }
  private purge(): void { for (const [id,capture] of this.captures) if (Date.parse(capture.result.page.expires_at) <= this.now()) this.captures.delete(id); }
  private binding(delivery: ContentDelivery, ref: ContentConversationRef, messageId: string, policy: TextPolicy): Promise<string> {
    return digest(stableJson([delivery.account_id,delivery.source_session_id,delivery.instance_id,ref,messageId,policy,delivery.authority_binding]));
  }
  private assertDelivery(delivery: ContentDelivery): void {
    if (!this.enabled || !this.available() || delivery.request.operation !== REFLECTION_OPERATION ||
      !delivery.authority_binding || !delivery.capabilities?.includes(REFLECTION_CAPABILITY) || !delivery.capabilities.includes('conversations-1')) fail('validation_failed');
  }
  private async observe(ref: ContentConversationRef, messageId: string): Promise<ReflectionObservation> {
    // Only one 16 MiB allocation reservation per host. Serial content host calls
    // retain captures under separate quotas while this reservation is held.
    if (this.work) return fail('resource_limit');
    this.work = true;
    try {
      const observation = await this.source.observe(ref,messageId);
      if (observation.content.length > REFLECTION_LIMITS.sourceBytes || utf8Bytes(observation.content) > REFLECTION_LIMITS.sourceBytes || observation.blocks.length > REFLECTION_LIMITS.blocks ||
        observation.metadata.length > 65536 || utf8Bytes(observation.metadata) > 65536 || observation.blocks.reduce((bytes,block) => bytes+utf8Bytes(block.content),0) > REFLECTION_LIMITS.sourceBytes) return { ...observation, content: '', metadata: '', blocks: [], state: 'too_large' };
      if ((observation.source === 'active') !== (observation.generationId !== null)) return fail('content_unavailable');
      return observation;
    } finally { this.work = false; }
  }
  private async capture(delivery: ContentDelivery, ref: ContentConversationRef, messageId: string, policy: TextPolicy, id: string): Promise<Capture> {
    this.purge();
    const capture = this.captures.get(id);
    if (!capture || capture.binding !== await this.binding(delivery,ref,messageId,policy)) return fail('snapshot_expired');
    return capture;
  }
  private async validateSource(delivery: ContentDelivery, capture: Capture, policy: TextPolicy, deadline: number): Promise<void> {
    if (deadline > this.now()+10000) return fail('unavailable');
    const guard = () => { if (!Number.isFinite(deadline) || this.now() >= deadline || deadline > Date.parse(delivery.expires_at) || this.now() >= Date.parse(capture.result.page.expires_at) || Date.parse(capture.result.page.observed_at) > this.now()) fail('snapshot_expired'); };
    guard(); await this.source.validateTarget(capture.result.ref); guard();
    const current = await this.observe(capture.result.ref,capture.result.message_id); guard();
    const result = capture.result;
    const sameState = result.content_state === 'too_large' ? current.state === 'too_large'
      : result.content_state === 'unavailable' ? current.state === 'unavailable'
      : result.content_state === 'withheld' ? current.state === 'withheld' || !safeWhole(current,policy)
      : !current.state && safeWhole(current,policy);
    const sameSource = current.source === result.source && current.turnId === result.turn_id && current.generationId === result.generation_id &&
      current.metadata === capture.metadata && (result.source === 'active' ? current.content.startsWith(capture.sourceContent) : current.content === capture.sourceContent);
    if (!sameState || !sameSource) { this.captures.delete(result.page.snapshot_id); fail('stale_revision'); }
    guard();
  }
  private page(capture: Capture, offset: number): ContentReflections {
    const result = capture.result;
    const items: ContentReflectionFragment[] = [];
    let envelopeBytes = 0;
    for (const fragment of capture.fragments.slice(offset,offset+REFLECTION_LIMITS.pageFragments)) {
      const size = utf8Bytes(JSON.stringify(fragment));
      if (items.length && envelopeBytes+size > 192*1024) break;
      items.push(fragment); envelopeBytes += size;
    }
    const next = offset+items.length;
    const cursor = next < capture.fragments.length ? [...capture.cursors].find(([,value]) => value === next)![0] : null;
    return structuredClone({ ...result, page: { ...result.page, offset, next_cursor: cursor }, items });
  }
  async handle(delivery: ContentDelivery, policy: TextPolicy, authorize: () => Promise<string>): Promise<ContentReflections> {
    this.assertDelivery(delivery);
    if (delivery.request.operation !== REFLECTION_OPERATION) return fail('validation_failed');
    const { ref,message_id: messageId,continuation } = delivery.request.body;
    // Authorization precedes target/source reads, also on continuation and replay.
    const deadline = Date.parse(await authorize());
    const guard = () => { if (!Number.isFinite(deadline) || this.now() >= deadline || deadline > this.now()+10000 || deadline > Date.parse(delivery.expires_at)) fail('unavailable'); };
    guard(); await this.source.validateTarget(ref); guard(); this.purge();
    let capture: Capture;
    let offset = 0;
    if (continuation) {
      capture = await this.capture(delivery,ref,messageId,policy,continuation.snapshot_id);
      const found = capture.cursors.get(continuation.cursor);
      if (found === undefined) return fail('validation_failed');
      offset = found;
    } else {
      // Capacity is checked before source hydration and fragment allocation.
      const session = stableJson([delivery.account_id,delivery.source_session_id,delivery.instance_id]);
      const own = [...this.captures.values()].filter(item => item.session === session);
      if (this.captures.size >= REFLECTION_LIMITS.instanceCaptures || own.length >= REFLECTION_LIMITS.sessionCaptures ||
        [...this.captures.values()].reduce((n,item) => n+item.bytes,0)+8*1024*1024 > REFLECTION_LIMITS.instanceBytes ||
        own.reduce((n,item) => n+item.bytes,0)+8*1024*1024 > REFLECTION_LIMITS.sessionBytes) return fail('resource_limit');
      const observed = this.now();
      const observation = await this.observe(ref,messageId); guard();
      const state = observation.state ?? (!safeWhole(observation,policy) ? 'withheld' : observation.blocks.length ? 'available' : observation.source === 'active' ? 'pending' : 'absent');
      const snapshot = crypto.randomUUID();
      const fragments: ContentReflectionFragment[] = [];
      if (state === 'available') {
        observation.blocks.forEach((block,index) => {
          const blockId = crypto.randomUUID();
          const total = utf8Bytes(block.content);
          let text = ''; let bytes = 0; let offset = 0;
          const flush = () => { if (!text) return; fragments.push({ fragment_id: crypto.randomUUID(),block_id: blockId,block_index: index,offset_bytes: offset,total_bytes: total,state: block.partial ? 'partial' : 'complete',text }); offset += bytes; text = ''; bytes = 0; };
          for (const char of block.content) { const size=utf8Bytes(char); if (bytes+size > REFLECTION_LIMITS.fragmentBytes) flush(); text+=char; bytes+=size; }
          flush();
        });
      }
      if (fragments.length > 256) return fail('resource_limit');
      const retainedBytes = utf8Bytes(observation.content)*6 + utf8Bytes(observation.metadata)*2 + 262144;
      capture = { binding: await this.binding(delivery,ref,messageId,policy),session,bytes: retainedBytes,sourceContent: observation.content,metadata: observation.metadata,
        fragments,cursors: new Map(),result: { ref: structuredClone(ref),message_id: messageId,turn_id: observation.turnId,source: observation.source,generation_id: observation.generationId,content_state: state,
          page: { snapshot_id: snapshot,revision: ++this.revision,observed_at: new Date(observed).toISOString(),expires_at: new Date(observed+(observation.source === 'active' ? REFLECTION_LIMITS.activeLifetime : REFLECTION_LIMITS.historyLifetime)).toISOString(),export_policy_revision: 'visible-1',offset: 0,total: fragments.length,next_cursor: null },items: [] } };
      // The pre-read reservation bounds every retained representation to 8 MiB.
      if (retainedBytes > 8*1024*1024) return fail('resource_limit');
      for (let next=1;next<fragments.length;next++) capture.cursors.set(crypto.randomUUID(),next);
      this.captures.set(snapshot,capture);
    }
    // Fresh authorization before the final comparison, never renewed midway.
    const finalDeadline = Date.parse(await authorize());
    await this.validateSource(delivery,capture,policy,finalDeadline);
    return this.page(capture,offset);
  }
  async validateEmission(delivery: ContentDelivery, result: ContentReflections, policy: TextPolicy, authorize: () => Promise<string>): Promise<void> {
    this.assertDelivery(delivery);
    const capture = await this.capture(delivery,result.ref,result.message_id,policy,result.page.snapshot_id);
    if (stableJson(this.page(capture,result.page.offset)) !== stableJson(result)) return fail('stale_revision');
    const deadline = Date.parse(await authorize());
    if (deadline > this.now()+10000) return fail('unavailable');
    await this.validateSource(delivery,capture,policy,deadline);
  }
}
