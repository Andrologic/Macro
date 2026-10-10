import type { ContentConversationInteractions, ContentConversationRef, ContentDelivery, ContentEvent, ContentRequest } from './contentProtocol';
import type { KernelStorage } from './kernel';
import { stableJson } from './protocol';
import { utf8Bytes, type TextPolicy } from './conversationText';

export const INTERACTION_CAPABILITY = 'conversation-interactions-1';
export const MODEL_CAPABILITY = 'conversation-models-1';
export const INTERACTION_OPERATIONS = new Set(['conversation.interactions', 'conversation.interact']);
export type InteractionBody = ContentRequest<'conversation.interact'>['body'];
export type InteractionState = Omit<ContentConversationInteractions, 'ref' | 'revision' | 'expires_at' | 'snapshot_id'>;
export interface InteractionSource {
  load(ref: ContentConversationRef, policy: TextPolicy): Promise<{ state: InteractionState; fingerprint: unknown }>;
  execute(body: InteractionBody, beforeEffect: (consumed?: boolean) => Promise<void>): Promise<void>;
}
interface Record { hash: string; revision: number }
interface Receipt { digest: string; target: string; state: 'pending' | 'applied' | 'retired'; revision: number; token?: string }
interface Journal { version: 1; records: { [key: string]: Record }; receipts: { [key: string]: Receipt } }
interface Capture { ref: ContentConversationRef; binding: string; key: string; revision: number; expires: number; policy: string }
const fail = (code: string): never => { throw new Error(code); };
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)))), byte => byte.toString(16).padStart(2, '0')).join('');

/** ContentHost serializes this owner. Persist only fingerprints and receipts.
 * A pending receipt blocks new intentions for that conversation after a crash.
 * A retry can return an applied receipt but can never run an uncertain effect. */
export class ConversationInteractions {
  private journal: Journal = { version: 1, records: {}, receipts: {} };
  private persisted: string | null = null;
  private captures = new Map<string, Capture>();
  private epoch = 0;
  private observationIndex = 0;
  constructor(private deps: { source: InteractionSource; storage: KernelStorage; now?: () => number; emit(change: ContentEvent['change']): Promise<void> }) {}
  private now() { return (this.deps.now ?? Date.now)(); }
  clear() { this.epoch++; this.captures.clear(); }
  async initialize() {
    this.persisted = await this.deps.storage.load();
    if (this.persisted === null) return;
    if (utf8Bytes(this.persisted) > 1024 * 1024) fail('resource_limit');
    const journal = JSON.parse(this.persisted) as Journal;
    const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
    const revision = (v: number) => Number.isSafeInteger(v) && v > 0;
    if (journal.version !== 1 || !journal.records || !journal.receipts ||
        Object.values(journal.records).some(record => !digest(record.hash) || !revision(record.revision)) ||
        Object.values(journal.receipts).some(receipt => !digest(receipt.digest) || !digest(receipt.target) || !revision(receipt.revision) || !['pending', 'applied', 'retired'].includes(receipt.state) || receipt.token !== undefined && !digest(receipt.token))) fail('content_unavailable');
    this.journal = journal;
  }
  private async save(next: Journal) {
    const value = stableJson(next);
    if (utf8Bytes(value) > 1024 * 1024 || Object.keys(next.receipts).length > 2000 || Object.keys(next.records).length > 2000) fail('resource_limit');
    if (!await this.deps.storage.compareAndSwap(this.persisted, value)) fail('conflict');
    this.persisted = value; this.journal = next;
  }
  private async load(ref: ContentConversationRef, policy: TextPolicy) {
    const epoch = this.epoch;
    const result = await this.deps.source.load(ref, policy);
    if (epoch !== this.epoch) fail('unavailable');
    if (utf8Bytes(stableJson(result)) > 180000) fail('resource_limit');
    const key = await hash(ref); const digest = await hash([result, policy]);
    const old = this.journal.records[key];
    if (!old || old.hash !== digest) {
      const next = structuredClone(this.journal);
      next.records[key] = { hash: digest, revision: (old?.revision ?? 0) + 1 };
      if (old) await this.deps.emit({ kind: 'conversation.interactions_changed', scope: ref, revision: next.records[key].revision });
      await this.save(next);
    }
    return { ...result, key, revision: this.journal.records[key].revision };
  }
  private binding(delivery: ContentDelivery, ref: ContentConversationRef) {
    return stableJson([delivery.account_id, delivery.source_session_id, delivery.instance_id, ref]);
  }
  private async current(delivery: ContentDelivery, body: InteractionBody, policy: TextPolicy) {
    const capture = this.captures.get(body.snapshot_id);
    if (!capture || capture.expires <= this.now() || capture.binding !== this.binding(delivery, body.ref) || capture.policy !== await hash(policy)) fail('snapshot_expired');
    const current = await this.load(body.ref, policy);
    if (capture!.revision !== body.expected_revision || current.revision !== capture!.revision) fail('stale_revision');
    return current;
  }
  async hasReceipt(delivery: ContentDelivery) {
    return delivery.request.operation === 'conversation.interact' && Boolean(this.journal.receipts[await hash([delivery.account_id, delivery.source_session_id, delivery.request.body.idempotency_key])]);
  }
  async observe(policy: TextPolicy) {
    for (const [id, capture] of this.captures) if (capture.expires <= this.now()) this.captures.delete(id);
    // Watch only opened conversations. The source contains no transcript bodies.
    const refs = [...new Map([...this.captures.values()].map(capture => [capture.key, capture.ref])).values()];
    // One source read per observation, regardless of the number of open captures.
    const ref = refs.length ? refs[this.observationIndex++ % refs.length] : undefined;
    if (ref) {
      try { await this.load(ref, policy); }
      catch { for (const [id, capture] of this.captures) if (stableJson(capture.ref) === stableJson(ref)) this.captures.delete(id); }
    }
  }
  async handle(delivery: ContentDelivery, policy: TextPolicy, authorize: () => Promise<void>): Promise<unknown> {
    if (!delivery.capabilities?.includes(INTERACTION_CAPABILITY) || !delivery.capabilities.includes('conversations-1')) fail('validation_failed');
    const request = delivery.request;
    await authorize();
    if (request.operation === 'conversation.interactions') {
      const loaded = await this.load(request.body.ref, policy);
      const id = crypto.randomUUID(); const expires = this.now() + 300000;
      for (const [key, capture] of this.captures) if (capture.expires <= this.now()) this.captures.delete(key);
      if (this.captures.size >= 128) fail('resource_limit');
      this.captures.set(id, { ref: request.body.ref, binding: this.binding(delivery, request.body.ref), key: loaded.key, revision: loaded.revision, expires, policy: await hash(policy) });
      await authorize();
      const state = structuredClone(loaded.state);
      if (!delivery.capabilities?.includes(MODEL_CAPABILITY)) {
        delete state.model_catalog;
        state.actions = state.actions.filter(action => action !== 'select_model');
      }
      return { ...state, ref: request.body.ref, snapshot_id: id, revision: loaded.revision, expires_at: new Date(expires).toISOString() };
    }
    if (request.operation !== 'conversation.interact') fail('validation_failed');
    const body = (request as ContentRequest<'conversation.interact'>).body;
    if (body.action === 'select_model' && !delivery.capabilities?.includes(MODEL_CAPABILITY)) fail('validation_failed');
    const key = await hash([delivery.account_id, delivery.source_session_id, body.idempotency_key]);
    const digest = await hash(body); const old = this.journal.receipts[key];
    if (old) {
      if (old.digest !== digest || old.state !== 'applied') fail('conflict');
      return { outcome: 'duplicate', revision: old.revision };
    }
    const current = await this.current(delivery, body, policy);
    // Retire an uncertain intention only when its exact native target has gone.
    // It remains non-replayable; a later question/generation can be acted on.
    const tokens = new Set(await Promise.all([
      ...(current.state.question ? [['answer', current.state.question.assistant_message_id]] : []),
      ...(current.state.generation_id ? [['stop', current.state.generation_id]] : []),
      ...(current.state.model_catalog ? [['select_model', current.state.model_catalog.selection]] : []),
    ].map(hash)));
    const uncertain = Object.values(this.journal.receipts).filter(receipt => receipt.target === current.key && receipt.state === 'pending');
    if (uncertain.some(receipt => !receipt.token || tokens.has(receipt.token))) fail('conflict');
    if (uncertain.length) {
      const reconciled = structuredClone(this.journal);
      for (const receipt of Object.values(reconciled.receipts)) if (receipt.target === current.key && receipt.state === 'pending') receipt.state = 'retired';
      await this.save(reconciled);
    }
    if (!current.state.actions.includes(body.action) ||
        body.action === 'stop' && current.state.generation_id !== body.generation_id ||
        body.action === 'answer' && current.state.question?.assistant_message_id !== body.assistant_message_id) fail('stale_revision');
    if (body.action === 'answer') {
      const answers = body.answers ?? [];
      const steps = current.state.question!.steps;
      if (steps.length !== answers.length || steps.some(step => {
        const answer = answers.find(answer => answer.step_id === step.step_id)?.answer.trim();
        return !answer || !step.free_text_allowed && !step.choices.includes(answer);
      })) fail('validation_failed');
    }
    if (body.action === 'select_model') {
      const selection = body.selection;
      const model = current.state.model_catalog?.models.find(model => model.provider_id === selection?.provider_id && model.model_id === selection?.model_id);
      if (!selection || !model || selection.reasoning_effort !== null && !model.reasoning_efforts.includes(selection.reasoning_effort)) fail('validation_failed');
    }
    const revision = body.expected_revision + 1;
    const next = structuredClone(this.journal);
    next.receipts[key] = { digest, target: current.key, state: 'pending', revision, token: await hash([body.action, body.action === 'answer' ? body.assistant_message_id : body.action === 'select_model' ? current.state.model_catalog?.selection : body.generation_id]) };
    await this.save(next);
    let effected = false;
    try {
      await this.deps.source.execute(body, async consumed => {
        await authorize();
        if (!consumed) { await this.current(delivery, body, policy); await authorize(); }
        effected = true;
      });
      if (!effected) fail('conflict');
      const final = await this.deps.source.load(body.ref, policy);
      const done = structuredClone(this.journal);
      done.receipts[key].state = 'applied';
      done.records[current.key] = { hash: await hash([final, policy]), revision };
      await this.deps.emit({ kind: 'conversation.interactions_changed', scope: body.ref, revision });
      await this.save(done);
      return { outcome: 'applied', revision };
    } catch {
      if (!effected) {
        const aborted = structuredClone(this.journal);
        delete aborted.receipts[key];
        await this.save(aborted);
      }
      return fail('conflict');
    }
  }
}
