import { assertA1, assertDelivery, assertDeliveryResult, errorEnvelope, object, PilotConversationSendPreflightRejection, PilotError, same, stableJson, validAnswers, type Command, type Delivery, type Resource, type Wire } from './protocol';
import { PilotStartPreflightRejection } from './startEligibility';

export interface CommandGuard { assertCurrent(): void; authorizeBeforeEffect(options?: { revision: 'expected' | 'consumed' }): Promise<void> }
export interface KernelStorage { load(): Promise<string | null>; compareAndSwap(previous: string | null, next: string): Promise<boolean> }
export interface KnownRun { runId: string; taskRef: Record<string, string>; createdAt: string; startedAt?: string; conversationId?: string; cancelledAt?: string; interruptedAt?: string }
export interface KernelDependencies {
  instanceId: string;
  storage: KernelStorage;
  project(previous: unknown, now: string, runs: KnownRun[]): { snapshots: Resource[]; state: unknown };
  execute(command: Command, guard: CommandGuard): Promise<{ conversationId?: string; startedAt?: string } | void>;
  authorize(delivery: Delivery): Promise<string>;
  validateReview?(review: Resource): Promise<void>;
  validateConversationSend?(command: Command): Promise<void>;
  now?: () => number;
}
interface JournalEntry {
  runId?: string; fingerprint: string; commandId: string; target: Record<string, string>;
  previousRevision: number; observedAt: string; status: 'executing' | 'indeterminate' | 'finished'; result?: Wire;
}
interface ScopedStream {
  streamId: string; scope: Wire; sequence: number; events: Wire[]; lastUsedAt: number;
}
interface KernelState {
  version: 2; projection: unknown; snapshots: Resource[]; streams: Record<string, ScopedStream>;
  journal: Record<string, JournalEntry>; reviews: Resource[]; runs: KnownRun[];
}
interface LegacyKernelState {
  version: 1; projection: unknown; snapshots: Resource[]; streamId: string; sequence: number; events: Wire[];
  journal: Record<string, JournalEntry>; reviews: Resource[]; runs: KnownRun[];
}
interface PageView { actor: string; scope: string; itemType: unknown; items: Resource[]; streamId?: string; sequence?: number; expiresAt: number }
const EVENT_LIMIT = 2000;
const STREAM_LIMIT = 128;
const PAGE_LIMIT = 128;
const MAX_BYTES = 1_048_576;
const immutable = <T>(value: T): T => structuredClone(value);
const keyOf = (resource: { ref: Record<string, string> }) => stableJson(resource.ref);
const directRefMatch = (ref: Record<string, string>, scope: Wire): boolean =>
  Object.entries(scope).every(([key, value]) => key === 'type' || ref[key] === value);
const inScope = (resource: Resource, scope: Wire, snapshots: Resource[]): boolean => {
  if (directRefMatch(resource.ref, scope)) return true;
  // Explicit project references (reviews) never inherit a different task project.
  if (scope.type !== 'project' || resource.ref.project_id || !resource.ref.task_id || resource.ref.workspace_id !== scope.workspace_id) return false;
  const task = resource.type === 'task'
    ? resource
    : snapshots.find(candidate => candidate.type === 'task' && candidate.ref.instance_id === resource.ref.instance_id &&
      candidate.ref.workspace_id === resource.ref.workspace_id && candidate.ref.task_id === resource.ref.task_id);
  return Array.isArray(task?.project_ids) && task.project_ids.includes(scope.project_id);
};
export class PilotKernel {
  private state!: KernelState;
  private persisted: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private ready = false;
  private readonly pages = new Map<string, PageView>();
  constructor(private readonly dependencies: KernelDependencies) {}
  private now() { return this.dependencies.now?.() ?? Date.now(); }
  private date() { return new Date(this.now()).toISOString(); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result;
  }
  async initialize(): Promise<void> {
    return this.exclusive(async () => {
      if (this.ready) return;
      this.persisted = await this.dependencies.storage.load();
      if (this.persisted) {
        const parsed = JSON.parse(this.persisted) as KernelState | LegacyKernelState;
        if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.snapshots) || !parsed.journal || !Array.isArray(parsed.reviews) || !Array.isArray(parsed.runs)) throw new PilotError('unavailable');
        parsed.snapshots.forEach(assertA1);
        if (parsed.version === 2) {
          if (!parsed.streams || typeof parsed.streams !== 'object' || Object.keys(parsed.streams).length > STREAM_LIMIT) throw new PilotError('unavailable');
          for (const [scopeKey, stream] of Object.entries(parsed.streams)) {
            if (scopeKey !== stableJson(stream.scope) || !stream.streamId || !Number.isSafeInteger(stream.sequence) || stream.sequence < 0 ||
              !Number.isFinite(stream.lastUsedAt) || !Array.isArray(stream.events) || stream.events.length > EVENT_LIMIT) throw new PilotError('unavailable');
            stream.events.forEach(assertA1);
            if (stream.events.some((event, index) => event.stream_id !== stream.streamId || event.sequence !== stream.sequence - stream.events.length + index + 1 || event.resume_cursor !== this.cursor(stream, Number(event.sequence)))) throw new PilotError('unavailable');
          }
          this.state = parsed;
        } else {
          // Version 1 mixed every scope in one stream. Preserve canonical state,
          // but invalidate its cursors rather than assigning that history to a scope.
          if (!parsed.streamId || !Number.isSafeInteger(parsed.sequence) || !Array.isArray(parsed.events)) throw new PilotError('unavailable');
          parsed.events.forEach(assertA1);
          this.state = { version: 2, projection: parsed.projection, snapshots: parsed.snapshots, streams: {}, journal: parsed.journal, reviews: parsed.reviews, runs: parsed.runs };
        }
        for (const entry of Object.values(this.state.journal)) if (entry.status === 'executing') {
          entry.status = 'indeterminate';
          const run = this.state.runs.find(run => run.runId === entry.runId);
          if (run) run.interruptedAt = this.date();
        }
      } else {
        this.state = { version: 2, projection: null, snapshots: [], streams: {}, journal: {}, reviews: [], runs: [] };
      }
      await this.refresh(); this.ready = true;
    });
  }
  private assertOpen() { if (!this.ready || this.closed) throw new PilotError('unavailable'); }
  private async save() {
    const next = stableJson(this.state);
    if (next === this.persisted) return;
    if (!await this.dependencies.storage.compareAndSwap(this.persisted, next)) { this.closed = true; throw new PilotError('conflict'); }
    this.persisted = next;
  }
  private project(): { snapshots: Resource[]; state: unknown } {
    const projected = this.dependencies.project(immutable(this.state.projection), this.date(), immutable(this.state.runs));
    const snapshots = [...projected.snapshots, ...this.state.reviews];
    snapshots.forEach(snapshot => { assertA1(snapshot); if (snapshot.ref.instance_id !== this.dependencies.instanceId) throw new PilotError('invalid_reference'); });
    return { snapshots, state: projected.state };
  }
  private async refresh() {
    const current = this.project();
    const old = new Map(this.state.snapshots.map(snapshot => [keyOf(snapshot), snapshot]));
    const currentByKey = new Map(current.snapshots.map(snapshot => [keyOf(snapshot), snapshot]));
    const invalidatedScopes = new Set<string>();
    for (const previous of this.state.snapshots) {
      const next = currentByKey.get(keyOf(previous));
      if (next && same(previous, next)) continue;
      for (const [pageId, page] of this.pages) {
        const pageScope = object(JSON.parse(page.scope));
        if (inScope(previous, pageScope, this.state.snapshots) !== Boolean(next && inScope(next, pageScope, current.snapshots))) this.pages.delete(pageId);
      }
      for (const [scopeKey, stream] of Object.entries(this.state.streams)) {
        if (inScope(previous, stream.scope, this.state.snapshots) !== Boolean(next && inScope(next, stream.scope, current.snapshots))) invalidatedScopes.add(scopeKey);
      }
    }
    for (const scopeKey of invalidatedScopes) this.invalidateStream(scopeKey);
    for (const snapshot of current.snapshots) {
      const previous = old.get(keyOf(snapshot));
      if (previous && snapshot.revision < previous.revision) throw new PilotError('conflict');
      if (same(snapshot, previous)) continue;
      if (previous && snapshot.revision === previous.revision) throw new PilotError('conflict');
      let eventType: string | null = null;
      if (['task', 'run', 'review'].includes(snapshot.type)) eventType = `${snapshot.type}.updated`;
      if (snapshot.type === 'decision' && ['pending', 'resolved'].includes(String(snapshot.state))) eventType = snapshot.state === 'pending' ? 'decision.requested' : 'decision.resolved';
      if (snapshot.type === 'tool_approval') eventType = `tool_approval.${snapshot.state === 'pending' ? 'requested' : snapshot.state}`;
      if (eventType) {
        for (const stream of Object.values(this.state.streams)) {
          if (!inScope(snapshot, stream.scope, current.snapshots)) continue;
          const sequence = ++stream.sequence;
          const event = { contract_version: '1.0', type: 'event', event_type: eventType, stream_id: stream.streamId, sequence,
            resume_cursor: this.cursor(stream, sequence), emitted_at: this.date(), resource: snapshot.ref, revision: snapshot.revision, snapshot };
          assertA1(event); stream.events.push(event); stream.events = stream.events.slice(-EVENT_LIMIT);
        }
      }
    }
    this.state.snapshots = immutable(current.snapshots); this.state.projection = current.state;
    await this.save();
  }
  private cursor(stream: ScopedStream, sequence: number) { return `${stream.streamId}:${sequence}`; }
  private invalidateStream(scopeKey: string) {
    const stream = this.state.streams[scopeKey];
    if (!stream) return;
    delete this.state.streams[scopeKey];
    for (const [pageId, page] of this.pages) if (page.streamId === stream.streamId || page.scope === scopeKey) this.pages.delete(pageId);
  }
  private streamFor(scope: Wire): ScopedStream {
    const scopeKey = stableJson(scope);
    let stream = this.state.streams[scopeKey];
    if (stream) { stream.lastUsedAt = this.now(); return stream; }
    while (Object.keys(this.state.streams).length >= STREAM_LIMIT) {
      const oldest = Object.entries(this.state.streams).sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0];
      this.invalidateStream(oldest[0]);
    }
    stream = { streamId: `stream:${crypto.randomUUID()}`, scope: immutable(scope), sequence: 0, events: [], lastUsedAt: this.now() };
    this.state.streams[scopeKey] = stream;
    return stream;
  }
  private currentTarget(command: Command): Resource {
    // Chat revisions belong to the content catalog, checked asynchronously before effects.
    if (command.kind === 'conversation.send') return { type: 'conversation', ref: command.target, revision: command.expected_revision };
    const resource = this.project().snapshots.find(snapshot => same(snapshot.ref, command.target));
    if (!resource) throw new PilotError('invalid_reference');
    if (resource.revision !== command.expected_revision) throw new PilotError('stale_revision');
    return resource;
  }
  private validateCommandState(command: Command, resource: Resource) {
    const payload = command.payload;
    if (command.kind === 'conversation.send') {
      if (!this.dependencies.validateConversationSend || !String(payload.content).trim()) throw new PilotError('validation_failed');
    } else if (command.kind === 'task.reply') {
      if (resource.state !== 'waiting_reply') throw new PilotError('stale_revision');
      if (object(resource.reply_context).conversation_id !== payload.conversation_id) throw new PilotError('invalid_reference');
    } else if (command.kind === 'decision.resolve') {
      if (resource.state !== 'pending') throw new PilotError('stale_revision');
      if (!validAnswers(resource.steps, payload.answers)) throw new PilotError('validation_failed');
    } else if (command.kind === 'tool_approval.resolve') {
      if (resource.state !== 'pending') throw new PilotError('stale_revision');
      if (payload.verdict === 'approve' && !(resource.allowed_scopes as unknown[]).includes(payload.grant_scope)) throw new PilotError('validation_failed');
    } else if (command.kind === 'run.start') {
      if (!['queued', 'failed'].includes(String(resource.state))) throw new PilotError('conflict');
    } else if (command.kind === 'run.cancel') {
      if (!['pending', 'running', 'waiting_reply', 'waiting_decision', 'waiting_tool_approval'].includes(String(resource.state))) throw new PilotError('stale_revision');
    } else if (command.kind === 'review.submit') {
      if (resource.state !== 'pending') throw new PilotError('stale_revision');
    } else throw new PilotError('validation_failed');
  }
  async handle(input: unknown): Promise<Wire> {
    assertDelivery(input);
    const delivery = immutable(input);
    return this.exclusive(async () => {
      try {
        this.assertOpen();
        const request = delivery.message;
        if (request.type === 'command') {
          const command = request as Command;
          if (!same(command.issued_by, delivery.actor)) throw new PilotError('forbidden');
          if (command.target.instance_id !== this.dependencies.instanceId) throw new PilotError('invalid_reference');
          return this.envelope(delivery, await this.command(delivery, command));
        }
        await this.dependencies.authorize(delivery); this.assertOpen();
        await this.refresh(); this.assertOpen();
        if (request.type === 'page_request') return await this.page(delivery);
        if (request.type === 'resume_request') return this.envelope(delivery, this.resume(request));
        throw new PilotError('validation_failed');
      } catch (error) {
        return this.envelope(delivery, errorEnvelope(delivery.exchange_id, error instanceof PilotError ? error.code : 'unavailable'));
      }
    });
  }
  private envelope(delivery: Delivery, message: Wire, resumePoint?: Wire): Wire {
    assertA1(message);
    const result = { transport_version: '1.0', type: 'delivery_result', exchange_id: delivery.exchange_id,
      delivery_id: delivery.delivery_id, message, ...(resumePoint ? { resume_point: resumePoint } : {}) };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BYTES) throw new PilotError('validation_failed');
    assertDeliveryResult(result);
    return result;
  }
  private async command(delivery: Delivery, command: Command): Promise<Wire> {
    const journalKey = stableJson([delivery.actor.session_id, command.idempotency_key]);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(command)));
    const fingerprint = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    this.assertOpen();
    const previous = this.state.journal[journalKey];
    if (previous && previous.fingerprint !== fingerprint) throw new PilotError('conflict');
    await this.dependencies.authorize(delivery); this.assertOpen();
    if (previous) {
      if (previous.status !== 'finished' || !previous.result) throw new PilotError('conflict');
      return immutable(previous.result);
    }
    await this.refresh(); this.assertOpen();
    if (command.kind === 'conversation.send') {
      if (!this.dependencies.validateConversationSend) throw new PilotError('unavailable');
      await this.dependencies.validateConversationSend(command); this.assertOpen();
    }
    const target = this.currentTarget(command); this.validateCommandState(command, target);
    if (command.kind === 'run.start' && this.state.runs.some(run => run.runId === command.payload.run_id)) throw new PilotError('conflict');
    const resultBase = { contract_version: '1.0', type: 'command_result', command_id: command.command_id,
      idempotency_key: command.idempotency_key, target: command.target, previous_revision: target.revision };
    const entry: JournalEntry = { fingerprint, commandId: command.command_id, target: command.target,
      previousRevision: target.revision, observedAt: this.date(), status: 'executing',
      ...(command.kind === 'run.start' ? { runId: String(command.payload.run_id) } : {}) };
    this.state.journal[journalKey] = entry;
    await this.save();
    let invoked = false;
    let effectGateEntered = false;
    try {
      let executeBefore = Infinity;
      const guard: CommandGuard = {
        assertCurrent: () => { this.assertOpen(); if (executeBefore <= this.now()) throw new PilotError('unavailable'); this.validateCommandState(command, this.currentTarget(command)); },
        authorizeBeforeEffect: async (options) => {
          effectGateEntered = true;
          const until = await this.dependencies.authorize(delivery);
          executeBefore = Date.parse(until);
          this.assertOpen();
          if (options?.revision !== 'consumed') {
            if (command.kind === 'conversation.send') await this.dependencies.validateConversationSend!(command);
            guard.assertCurrent();
          }
          if (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= this.now()) throw new PilotError('unavailable');
        },
      };
      guard.assertCurrent();
      if (command.kind === 'review.submit') {
        if (!this.dependencies.validateReview) throw new PilotError('unavailable');
        await this.dependencies.validateReview(this.currentTarget(command));
        await guard.authorizeBeforeEffect();
        await this.dependencies.validateReview(this.currentTarget(command));
        guard.assertCurrent();
        invoked = true;
        const review = this.state.reviews.find(item => same(item.ref, command.target));
        if (!review) throw new PilotError('invalid_reference');
        review.state = command.payload.verdict === 'approve' ? 'approved' : 'changes_requested';
        if (command.payload.note) review.verdict_note = command.payload.note;
        review.updated_at = this.date(); review.revision += 1;
      } else {
        if (command.kind === 'run.start') {
          this.state.runs.push({ runId: String(command.payload.run_id), taskRef: command.target, createdAt: this.date() });
          await this.save(); guard.assertCurrent();
        }
        invoked = true;
        const execution = await this.dependencies.execute(command, guard);
        if (command.kind === 'run.start') {
          if (!execution?.conversationId) throw new PilotError('unavailable');
          const run = this.state.runs.find(item => item.runId === command.payload.run_id)!;
          run.conversationId = execution.conversationId;
          run.startedAt = execution.startedAt ?? this.date();
        }
        if (command.kind === 'run.cancel') {
          const run = this.state.runs.find(item => item.runId === command.target.run_id);
          if (run) run.cancelledAt = this.date();
        }
      }
      await this.refresh();
      const resulting = this.state.snapshots.find(snapshot => same(snapshot.ref, command.target));
      entry.result = { ...resultBase, outcome: 'accepted', resulting_revision: resulting?.revision ?? target.revision };
      entry.status = 'finished'; await this.save(); return immutable(entry.result);
    } catch (error) {
      // Before invocation no desktop effect is possible. After invocation only
      // explicit desktop preflight refusals can prove absence of effects.
      const safeStartRejection = command.kind === 'run.start' && !effectGateEntered &&
        error instanceof PilotStartPreflightRejection;
      if (command.kind === 'run.start' && (!invoked || safeStartRejection)) {
        this.state.runs = this.state.runs.filter(run => run.runId !== command.payload.run_id);
        delete entry.runId;
      }
      if (command.kind === 'run.start') {
        const run = this.state.runs.find(run => run.runId === command.payload.run_id);
        if (run) run.interruptedAt = this.date();
      }
      const safeConversationRejection = command.kind === 'conversation.send' && error instanceof PilotConversationSendPreflightRejection;
      if (invoked && !safeStartRejection && !safeConversationRejection) { entry.status = 'indeterminate'; await this.save(); throw new PilotError('conflict'); }
      const code = error instanceof PilotError ? error.code : 'unavailable';
      entry.result = { ...resultBase, outcome: 'rejected', error: { code, message: code, retryable: code === 'unavailable' } };
      entry.status = 'finished'; await this.save(); return immutable(entry.result);
    }
  }
  private async page(delivery: Delivery): Promise<Wire> {
    const request = delivery.message; const scope = object(request.scope);
    if (scope.instance_id !== this.dependencies.instanceId) throw new PilotError('invalid_reference');
    const scopeKey = stableJson(scope); const actor = stableJson(delivery.actor); let view: PageView; let offset = 0; let id: string;
    for (const [key, value] of this.pages) if (value.expiresAt <= this.now()) this.pages.delete(key);
    if (request.cursor) {
      const parts = String(request.cursor).split('/'); id = parts[0]; offset = Number(parts[1]);
      const found = this.pages.get(id);
      const stream = found?.streamId ? this.state.streams[scopeKey] : undefined;
      if (!found || !Number.isSafeInteger(offset) || offset < 0 || found.actor !== actor || found.scope !== scopeKey || found.itemType !== request.item_type ||
        (found.streamId && (!stream || stream.streamId !== found.streamId || found.sequence === undefined || found.sequence < stream.sequence - stream.events.length))) throw new PilotError('cursor_expired');
      view = found;
    } else {
      id = `page:${crypto.randomUUID()}`;
      const stream = request.item_type === 'task' ? this.streamFor(scope) : undefined;
      view = { actor, scope: scopeKey, itemType: request.item_type,
        items: immutable(this.state.snapshots.filter(snapshot => snapshot.type === request.item_type && inScope(snapshot, scope, this.state.snapshots))),
        ...(stream ? { streamId: stream.streamId, sequence: stream.sequence } : {}), expiresAt: this.now() + 300_000 };
      while (this.pages.size >= PAGE_LIMIT) this.pages.delete(this.pages.keys().next().value!);
      this.pages.set(id, view);
      // The stream and exact snapshot boundary must survive a restart before the
      // bootstrap response can be observed by the relay client.
      if (stream) await this.save();
    }
    const items = view.items.slice(offset, offset + Number(request.limit)); const next = offset + items.length;
    const message = { contract_version: '1.0', type: 'page', item_type: request.item_type, items, has_more: next < view.items.length,
      ...(next < view.items.length ? { next_cursor: `${id}/${next}` } : {}) };
    const stream = view.streamId ? this.state.streams[scopeKey] : undefined;
    if (view.streamId && (!stream || stream.streamId !== view.streamId || view.sequence === undefined)) throw new PilotError('cursor_expired');
    return this.envelope(delivery, message, stream ? { stream_id: stream.streamId, after_cursor: this.cursor(stream, view.sequence!), after_sequence: view.sequence } : undefined);
  }
  private resume(request: Wire): Wire {
    const sequence = Number(request.after_sequence);
    const stream = Object.values(this.state.streams).find(candidate => candidate.streamId === request.stream_id);
    if (!stream || request.after_cursor !== this.cursor(stream, sequence) || sequence > stream.sequence || sequence < stream.sequence - stream.events.length) throw new PilotError('cursor_expired');
    stream.lastUsedAt = this.now();
    const events = stream.events.filter(event => Number(event.sequence) > sequence).slice(0, Number(request.limit));
    return { contract_version: '1.0', type: 'event_batch', stream_id: stream.streamId, after_cursor: request.after_cursor, after_sequence: sequence,
      events, next_sequence: events.at(-1)?.sequence ?? sequence, next_cursor: events.at(-1)?.resume_cursor ?? request.after_cursor };
  }
  getReviews(): Resource[] { return immutable(this.state.reviews); }
  getKnownRuns(): KnownRun[] { return immutable(this.state.runs); }
  async recordReview(review: Resource): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen(); assertA1(review);
      if (review.type !== 'review' || review.ref.instance_id !== this.dependencies.instanceId) throw new PilotError('invalid_reference');
      const previous = this.state.reviews.find(item => same(item.ref, review.ref));
      if (previous) return;
      for (const old of this.state.reviews) {
        if (old.ref.task_id === review.ref.task_id && old.ref.project_id === review.ref.project_id && old.state !== 'superseded') {
          old.state = 'superseded'; old.revision++; old.updated_at = this.date();
        }
      }
      this.state.reviews.push(immutable(review)); await this.refresh();
    });
  }
  async observe(): Promise<void> { return this.exclusive(async () => { this.assertOpen(); await this.refresh(); }); }
  close() { this.closed = true; this.pages.clear(); }
  indeterminate(): Array<{ key: string; commandId: string; target: Record<string, string> }> {
    return Object.entries(this.state.journal).filter(([,entry]) => entry.status === 'indeterminate').map(([key, entry]) => ({ key, commandId: entry.commandId, target: immutable(entry.target) }));
  }
  async reconcileNotExecuted(key: string): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen(); const entry = this.state.journal[key];
      if (!entry || entry.status !== 'indeterminate') throw new PilotError('conflict');
      entry.result = { contract_version: '1.0', type: 'command_result', command_id: entry.commandId,
        idempotency_key: JSON.parse(key)[1], target: entry.target, previous_revision: entry.previousRevision,
        outcome: 'rejected', error: { code: 'conflict', message: 'Locally reconciled. A new explicit command is required.', retryable: false } };
      entry.status = 'finished'; await this.save();
    });
  }
}
