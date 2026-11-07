/** Persist the inputs and exact receipts of the pure 04 controller. Native SQL
 * owns the revision, attribution and effects; rebuilding this controller never
 * dispatches a provider, check, timer or flow transition. */
export interface PureWorkController030<Event, Receipt> {
  dispatch(event: Event): Receipt;
}

interface JournalEntry030 {
  readonly eventJson: string;
  readonly receiptJson: string;
}
interface Journal030 {
  readonly format: 'macro-agsdl-work-journal/1';
  readonly events: readonly JournalEntry030[];
}

export const EMPTY_WORK_JOURNAL030 = '{"format":"macro-agsdl-work-journal/1","events":[]}';

/** The event envelope is native-authenticated; authored JSON values inside an
 * event remain strings. expectedNativeRevision is the DB017 CAS revision: it
 * counts committed journal entries. The controller's receipt revision is a
 * separate counter and can stay unchanged on a duplicate operation. DB must
 * deduplicate a repeated event/call before evaluating it, or reserve a distinct
 * native entry; only an atomically claimed native effect may actually run.
 * A changed controller or corrupted receipt fails closed on recovery. */
export function evaluateWorkJournal030<Event, Receipt>(
  stateJson: string,
  expectedNativeRevision: string,
  eventJson: string,
  createController: () => PureWorkController030<Event, Receipt>,
): { readonly stateJson: string; readonly receiptJson: string } {
  if (!/^(0|[1-9][0-9]*)$/.test(expectedNativeRevision)) throw new Error('Invalid work journal revision.');
  const parsed: unknown = JSON.parse(stateJson);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid work journal.');
  const state = parsed as Record<string, unknown>;
  if (state.format !== 'macro-agsdl-work-journal/1' || !Array.isArray(state.events)
    || Object.keys(state).some(key => key !== 'format' && key !== 'events')
    || BigInt(expectedNativeRevision) !== BigInt(state.events.length)) throw new Error('Work journal and native revision differ.');
  const entries: JournalEntry030[] = [];
  const controller = createController();
  for (const raw of state.events) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid work journal entry.');
    const entry = raw as Record<string, unknown>;
    if (typeof entry.eventJson !== 'string' || typeof entry.receiptJson !== 'string'
      || Object.keys(entry).some(key => key !== 'eventJson' && key !== 'receiptJson')) throw new Error('Invalid work journal entry.');
    const result = controller.dispatch(JSON.parse(entry.eventJson) as Event);
    if (JSON.stringify(result) !== entry.receiptJson) throw new Error('Work journal receipt cannot be reproduced.');
    entries.push({ eventJson: entry.eventJson, receiptJson: entry.receiptJson });
  }
  const receiptJson = JSON.stringify(controller.dispatch(JSON.parse(eventJson) as Event));
  if (typeof receiptJson !== 'string') throw new Error('Work controller returned no receipt.');
  const journal: Journal030 = { format: 'macro-agsdl-work-journal/1', events: [...entries, { eventJson, receiptJson }] };
  return { stateJson: JSON.stringify(journal), receiptJson };
}
