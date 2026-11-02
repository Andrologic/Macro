import type { ExactJsonText, ExecutionContext, ProviderAttemptId, Sequence } from './contracts';
import { ConformanceError, decode, encode, equal, fail, has, record, text, type ExactObject } from './exact';
import { sameWork } from './invariants';
import { ExactResponseCollection, type ResponseCollectionOptions } from './responses';

/** Returned only by the authenticated native journal. Every emission was checked
 * against a durable provider effect before it entered this sequence. */
export interface RetainedEmission {
  readonly context: ExecutionContext;
  readonly providerAttemptId: ProviderAttemptId;
  readonly sequence: Sequence;
  readonly identity: string;
  readonly kind: 'message' | 'publication' | 'rejectedPublication';
  /** A message has textParts. A publication retains rawArguments as a string,
   * including invalid JSON, before any tool argument conversion. */
  readonly bodyJson: ExactJsonText;
}
export type ResponseValidation =
  | { readonly kind: 'success'; readonly text: string; readonly resultsJson: ExactJsonText; readonly choice: string | null }
  | { readonly kind: 'failure'; readonly code: 'OUTPUT_CONSTRAINT'; readonly diagnostics: readonly { readonly sequence: Sequence; readonly pointer: string; readonly message: string }[] };
export interface RetainedResponses {
  readonly events: readonly RetainedEmission[];
  readonly digest: string;
}
export interface ResponseJournalPort {
  read(context: ExecutionContext): Promise<RetainedResponses>;
  close(closure: {
    readonly owner: ExecutionContext['owner']; readonly work: ExecutionContext['work'];
    readonly cursor: Sequence; readonly digest: string; readonly validationJson: ExactJsonText;
  }): Promise<{ readonly cursor: Sequence; readonly digest: string; readonly validationJson: ExactJsonText }>;
}
/** Transport attribution/continuity failures are never converted to a normative
 * output failure. Only publication or final completion validation can do that. */
export async function validateRetainedResponses(
  options: Omit<ResponseCollectionOptions, 'providerAttempts'>,
  retained: RetainedResponses,
): Promise<{ readonly cursor: Sequence; readonly validation: ResponseValidation }> {
  const expected = options.context;
  const identities = new Set<string>();
  const attempts = new Set<ProviderAttemptId>();
  for (const [index, event] of retained.events.entries()) {
    const actual = event.context;
    if (event.sequence !== String(index + 1) || !event.identity || identities.has(event.identity)
      || !event.providerAttemptId?.trim() || !sameWork(actual.work, expected.work)
      || actual.owner.systemStartId !== expected.owner.systemStartId || actual.owner.ownerEpoch !== expected.owner.ownerEpoch
      || actual.registryVersion !== expected.registryVersion
      || !equal(decode(actual.permissionsJson), decode(expected.permissionsJson))
      || !equal(decode(actual.scopeJson), decode(expected.scopeJson))) {
      fail('CORRELATION', '/responses', 'Retained response attribution or sequence is inconsistent.');
    }
    identities.add(event.identity); attempts.add(event.providerAttemptId);
  }
  const cursor = String(retained.events.length) as Sequence;
  const collector = new ExactResponseCollection({ ...options, providerAttempts: [...attempts] });
  let accepted = 0;
  const diagnostics: { sequence: Sequence; pointer: string; message: string }[] = [];
  for (const event of retained.events) {
    const sequence = String(accepted + 1) as Sequence;
    const body = record(decode(event.bodyJson));
    if (event.kind === 'message') {
      if (!Array.isArray(body.textParts) || body.textParts.some(part => typeof part !== 'string')) {
        fail('CORRELATION', '/responses', 'Retained visible message is malformed.');
      }
      await collector.append({ context: event.context, providerAttemptId: event.providerAttemptId,
        messageId: event.identity as import('./contracts').ResponseMessageId, sequence, textParts: body.textParts as string[] });
      accepted++;
      continue;
    }
    if (event.kind !== 'publication' && event.kind !== 'rejectedPublication') {
      fail('CORRELATION', '/responses', 'Unknown retained emission.');
    }
    // The envelope is transport metadata. Its absence is a broken journal, not
    // malformed model output. The raw argument string itself may be invalid JSON.
    const raw = text(body.rawArguments, '/rawArguments');
    try {
      if (event.kind === 'rejectedPublication') fail('OUTPUT_CONSTRAINT', '', 'Publication was rejected at its dispatch boundary.');
      if (options.publicationContractJson === null) fail('OUTPUT_CONSTRAINT', '', 'No publication contract is captured for this work.');
      const publication = record(decode(raw));
      if (Object.keys(publication).some(key => key !== 'results' && key !== 'choice')) fail('OUTPUT_CONSTRAINT', '', 'Unknown publication property.');
      const results = record(publication.results ?? {});
      const choice = has(publication, 'choice') ? text(publication.choice, '/choice') : null;
      await collector.publish({ context: event.context, providerAttemptId: event.providerAttemptId,
        publicationId: event.identity, sequence, contractJson: options.publicationContractJson,
        resultsJson: encode(results), choice });
      accepted++;
    } catch (error) {
      if (!(error instanceof ConformanceError)) throw error;
      diagnostics.push({ sequence: event.sequence, pointer: error.pointer, message: error.message });
    }
  }
  try {
    const completion = await collector.close(expected, String(accepted) as Sequence);
    if (!diagnostics.length) return { cursor, validation: { kind: 'success', text: completion.text, resultsJson: completion.resultsJson, choice: completion.choice } };
  } catch (error) {
    if (!(error instanceof ConformanceError) || error.code !== 'OUTPUT_CONSTRAINT') throw error;
    diagnostics.push({ sequence: cursor, pointer: error.pointer, message: error.message });
  }
  return { cursor, validation: { kind: 'failure', code: 'OUTPUT_CONSTRAINT', diagnostics } };
}

export async function closeRetainedResponses(
  options: Omit<ResponseCollectionOptions, 'providerAttempts'>,
  journal: ResponseJournalPort,
): Promise<{ readonly cursor: Sequence; readonly digest: string; readonly validation: ResponseValidation }> {
  const retained = await journal.read(options.context);
  const { cursor, validation } = await validateRetainedResponses(options, retained);
  const validationJson = encode(validation as unknown as ExactObject);
  // Native close rechecks digest, epoch, complete sequence and every physical
  // effect under its transaction. No local validation can settle an active owner.
  const receipt = await journal.close({ owner: options.context.owner, work: options.context.work,
    cursor, digest: retained.digest, validationJson });
  if (receipt.cursor !== cursor || receipt.digest !== retained.digest || !equal(decode(receipt.validationJson), decode(validationJson))) {
    fail('CORRELATION', '', 'Response closure receipt contradicts the retained journal.');
  }
  return { cursor, digest: receipt.digest, validation };
}
