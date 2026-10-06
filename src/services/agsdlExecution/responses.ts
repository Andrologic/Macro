import { schema } from '../../vendor/agsdl/v0.2/values.mjs';
import type { ExactJsonText, ExecutionContext, ProviderAttemptId, ResponseCollectionPort, Sequence, TypedPublication, VisibleResponseMessage } from './contracts';
import { validateCompletion } from './constraints';
import { assembleVisibleText, compareSequence, sameWork } from './invariants';
import { clone, decode, encode, equal, fail, has, list, record, shape, text, type ExactObject } from './exact';
import { PUBLICATION_PROTOCOL } from './registry';

export interface ResponseCollectionOptions {
  readonly context: ExecutionContext;
  /** Only attempts already registered by the adapter may emit. No inferred attribution. */
  readonly providerAttempts: readonly ProviderAttemptId[];
  readonly interfaceJson: ExactJsonText;
  readonly stepJson: ExactJsonText | null;
  /** Explicit agent identity for graphless work; this creates no graph or task. */
  readonly agentName?: string;
  readonly publicationContractJson: ExactJsonText | null;
  readonly limits?: { readonly maxEvents: number; readonly maxTextBytes: number };
}
/** Pure in-memory collection. The future adapter must persist emissions/order and its closed cursor. */
export class ExactResponseCollection implements ResponseCollectionPort {
  private readonly options: ResponseCollectionOptions;
  private readonly events = new Map<string, { kind: 'message' | 'publication'; identity: string; signature: ExactJsonText }>();
  private readonly messages = new Map<string, VisibleResponseMessage>();
  private readonly publications = new Map<string, TypedPublication>();
  private closed: { text: string; resultsJson: ExactJsonText; choice: string | null; cursor: Sequence } | null = null;
  private bytes = 0;
  private sequence(value: Sequence, pointer = '/sequence'): void {
    try { compareSequence(value, value); }
    catch { fail('CORRELATION', pointer, 'Invalid canonical emission sequence.'); }
  }
  constructor(options: ResponseCollectionOptions) {
    this.options = clone(options);
    this.sequence(options.context.owner.ownerEpoch as unknown as Sequence, '/ownerEpoch');
    if (!options.context.registryVersion || !options.context.work.agentInstanceId || [options.context.work.systemStartId, options.context.work.flowInvocationId, options.context.work.activationId, options.context.work.agentInstanceId].some(value => typeof value !== 'string' || value === '') || options.providerAttempts.some(attempt => typeof attempt !== 'string' || attempt === '')) fail('CORRELATION', '', 'Collection identities must be explicit and nonempty.');
    if (options.context.work.step !== null && !shape(options.context.work.step, schema.$defs.StepAddress)) fail('CORRELATION', '/step', 'Invalid work address.');
    if (new Set(options.providerAttempts).size !== options.providerAttempts.length) fail('CORRELATION', '', 'Repeated registered provider attempt.');
    if (options.limits && (!Number.isSafeInteger(options.limits.maxEvents) || options.limits.maxEvents < 1 || !Number.isSafeInteger(options.limits.maxTextBytes) || options.limits.maxTextBytes < 0)) fail('CORRELATION', '', 'Invalid collection bounds.');
    const interfaceValue = decode(options.interfaceJson), step = this.step();
    if (options.stepJson === null && (!options.agentName || options.context.work.step !== null)) fail('CORRELATION', '', 'Graphless collection needs an explicit Agent and null work address.');
    if (!shape(interfaceValue, schema.$defs.Interface) || !shape(step, schema.$defs.Step)) fail('CORRELATION', '', 'Invalid collection declarations.');
    if (record(step).type !== 'agent') fail('CORRELATION', '', 'Collection must belong to an Agent step.');
    if (options.publicationContractJson !== null) {
      const contract = record(decode(options.publicationContractJson));
      const expectedChoices = has(record(step), 'decision') ? record(record(step).decision).choices : [];
      if (contract.protocol !== PUBLICATION_PROTOCOL || contract.registryVersion !== options.context.registryVersion || !equal(contract.interface, interfaceValue) || !equal(contract.choices, expectedChoices) || !equal(contract.step, options.context.work.step) || contract.agent !== record(step).agent) fail('CORRELATION', '', 'Publication contract does not match this work.');
    }
  }
  private step(): ExactObject {
    return this.options.stepJson === null ? { type: 'agent', agent: this.options.agentName ?? '' } : record(decode(this.options.stepJson));
  }
  private correlate(context: ExecutionContext, providerAttemptId?: ProviderAttemptId): void {
    const expected = this.options.context;
    if (!context || !context.owner || !context.work || context.work.step !== null && !Array.isArray(context.work.step)) fail('CORRELATION', '', 'Invalid response attribution envelope.');
    if (!sameWork(context.work, expected.work) || context.owner.systemStartId !== context.work.systemStartId || context.owner.systemStartId !== expected.owner.systemStartId || context.owner.ownerEpoch !== expected.owner.ownerEpoch || context.registryVersion !== expected.registryVersion || !equal(decode(context.permissionsJson), decode(expected.permissionsJson)) || !equal(decode(context.scopeJson), decode(expected.scopeJson))) fail('CORRELATION', '', 'Response is not attributed to the current work.');
    if (providerAttemptId !== undefined && !this.options.providerAttempts.includes(providerAttemptId)) fail('CORRELATION', '', 'Provider attempt is not registered.');
  }
  private inspect(sequence: Sequence, identity: string, signature: ExactJsonText, kind: 'message' | 'publication'): 'accepted' | 'duplicate' {
    if (this.closed) fail('CORRELATION', '', 'Response collection is closed.');
    this.sequence(sequence);
    if (typeof identity !== 'string' || !identity || compareSequence(sequence, '0' as Sequence) <= 0) fail('CORRELATION', '', 'Emission identity and positive canonical sequence are required.');
    const retained = this.events.get(sequence);
    if (retained) {
      if (retained.identity === identity && retained.kind === kind && equal(decode(retained.signature), decode(signature))) return 'duplicate';
      fail('CORRELATION', '', 'Conflicting emission sequence.');
    }
    if (this.events.size >= (this.options.limits?.maxEvents ?? 10_000)) fail('CORRELATION', '', 'Collection event bound exceeded.');
    return 'accepted';
  }
  async append(message: VisibleResponseMessage): Promise<'accepted' | 'duplicate'> {
    this.correlate(message.context, message.providerAttemptId);
    if (!Array.isArray(message.textParts) || message.textParts.some(part => typeof part !== 'string')) fail('CORRELATION', '', 'Visible parts must be attributed text.');
    const signature = encode(message as unknown as ExactObject);
    const status = this.inspect(message.sequence, message.messageId, signature, 'message');
    if (status === 'duplicate') return status;
    if (this.messages.has(message.messageId)) fail('CORRELATION', '', 'Message identity was reused.');
    const bytes = message.textParts.reduce((sum, part) => sum + new TextEncoder().encode(part).byteLength, 0);
    if (this.bytes + bytes > (this.options.limits?.maxTextBytes ?? 2_000_000)) fail('CORRELATION', '', 'Collection text bound exceeded.');
    this.messages.set(message.messageId, clone(message));
    this.events.set(message.sequence, { kind: 'message', identity: message.messageId, signature });
    this.bytes += bytes;
    return 'accepted';
  }
  async publish(publication: TypedPublication): Promise<'accepted' | 'duplicate'> {
    this.correlate(publication.context, publication.providerAttemptId);
    if (this.options.publicationContractJson === null || !equal(decode(publication.contractJson), decode(this.options.publicationContractJson))) fail('CORRELATION', '', 'Publication requires the explicit captured registry protocol.');
    const signature = encode(publication as unknown as ExactObject);
    const status = this.inspect(publication.sequence, publication.publicationId, signature, 'publication');
    if (status === 'duplicate') return status;
    if (this.publications.has(publication.publicationId)) fail('CORRELATION', '', 'Publication identity was reused.');
    const results = record(decode(publication.resultsJson));
    const interfaceValue = record(decode(this.options.interfaceJson));
    const declared = record(interfaceValue.results ?? {});
    if (Object.keys(results).some(name => !has(declared, name))) fail('OUTPUT_CONSTRAINT', '/results', 'Publication result is not declared.');
    const partial = clone(interfaceValue);
    partial.results = Object.fromEntries(Object.entries(declared).map(([name, rule]) => [name, { ...record(rule), required: false }]));
    // A partial publication can omit required outputs; final close validates the complete set.
    validateCompletion(partial, { type: 'agent' }, { results });
    const step = this.step();
    if (publication.choice !== null && (!has(step, 'decision') || !list(record(step.decision).choices).includes(publication.choice))) fail('OUTPUT_CONSTRAINT', '/choice', 'Publication choice is not declared.');
    for (const existing of this.publications.values()) {
      if (Object.keys(record(decode(existing.resultsJson))).some(name => has(results, name)) || existing.choice !== null && publication.choice !== null) fail('CORRELATION', '', 'Publication result or choice is ambiguous.');
    }
    this.publications.set(publication.publicationId, clone(publication));
    this.events.set(publication.sequence, { kind: 'publication', identity: publication.publicationId, signature });
    return 'accepted';
  }
  async close(context: ExecutionContext, finalCursor: Sequence): Promise<{ text: string; resultsJson: ExactJsonText; choice: string | null; cursor: Sequence }> {
    this.correlate(context);
    this.sequence(finalCursor, '/cursor');
    if (this.closed) {
      if (this.closed.cursor !== finalCursor) fail('CORRELATION', '', 'Conflicting closed cursor.');
      return { ...this.closed };
    }
    if (BigInt(finalCursor) !== BigInt(this.events.size)) fail('CORRELATION', '', 'Emission cursor contains a hole or omits events.');
    const ordered: VisibleResponseMessage[] = [];
    const results: ExactObject = {};
    let choice: string | null = null;
    for (let position = 1; position <= this.events.size; position++) {
      const event = this.events.get(String(position));
      if (!event) fail('CORRELATION', '', 'Emission sequence contains a hole.');
      if (event.kind === 'message') ordered.push(this.messages.get(event.identity)!);
      else {
        const publication = this.publications.get(event.identity)!;
        Object.assign(results, clone(record(decode(publication.resultsJson))));
        if (publication.choice !== null) choice = publication.choice;
      }
    }
    const visible = assembleVisibleText(ordered.map(message => message.textParts));
    const normalized = validateCompletion(record(decode(this.options.interfaceJson)), this.step(), { text: visible, results, ...(choice !== null ? { choice } : {}) });
    this.closed = { text: text(normalized.text), resultsJson: encode(record(normalized.results)), choice, cursor: finalCursor };
    return { ...this.closed };
  }
}
