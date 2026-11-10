import type { RunHumanRequest030, RunRead030 } from '../../types/agsdlRunUi030';
import type { HumanScope030 } from '../../types/generated/ipc';
import { readExecutionHumans030, readExecutionSnapshot030, submitExecutionHuman030 } from '../tauriIpc';
import { MacroServiceError, toServiceError } from '../contracts/errors';
import { integer030, compareIntegers030, boundedInteger030 } from '../agsdlExecution/workIntegers030';
import { createHumanRequestClient030, loadHumanRequests030 } from './humanRequests030';
import type { HumanDraftStorage030, ReadHuman030, SubmitHuman030 } from './humanRequests030';

export interface HumanReadTransport030 {
  readExecutionHumans030: typeof readExecutionHumans030;
  readExecutionSnapshot030: typeof readExecutionSnapshot030;
  submitExecutionHuman030?: typeof submitExecutionHuman030;
}

export const sameHumanScope030 = (a: HumanScope030, b: HumanScope030) =>
  a.systemStartId === b.systemStartId && a.source.revision === b.source.revision &&
  a.source.sourceSha256 === b.source.sourceSha256 &&
  a.source.owner.projectId === b.source.owner.projectId &&
  a.source.owner.planId === b.source.owner.planId && a.source.owner.branch === b.source.owner.branch;

/** Publish only a complete snapshot of the retained native flow. */
export async function readHumanFacts030(scope: HumanScope030,
  read = readExecutionHumans030): Promise<RunRead030<readonly RunHumanRequest030[]>> {
  let page;
  try { page = await loadHumanRequests030(scope, read, () => true); }
  catch (error) {
    if (toServiceError(error).code === 'NOT_FOUND') return { kind: 'unavailable', gap: 'human-flow-projection' };
    throw error;
  }
  if (!page) throw new MacroServiceError('CORRELATION', 'Human page was superseded');
  if (page.requests.some(request => !request.flowJson)) return { kind: 'unavailable', gap: 'human-flow-projection' };
  const requests = page.requests.map(request => {
    if (!request.flowJson) throw new MacroServiceError('DTO_UNAVAILABLE', 'True-flow human facts are absent');
    const value = JSON.parse(request.flowJson) as RunHumanRequest030;
    if (!sameHumanScope030(value.scope, scope) || value.id !== request.id || value.revision !== request.revision ||
        !Array.isArray(value.occurrences) || !value.content?.kind || !value.state?.kind || !value.clock?.kind)
      throw new MacroServiceError('CORRELATION', 'Human flow facts differ');
    if (value.clock.kind === 'available' && value.clock.value.timeoutMs !== null) {
      const limit = integer030(value.clock.value.timeoutMs, true);
      if (compareIntegers030(limit, '18446744073709551615') > 0)
        return { ...value, clock: { kind: 'unavailable' as const, gap: 'human-clock-observation' as const } };
      return { ...value, clock: { kind: 'available' as const, value: { ...value.clock.value,
        timeoutMs: boundedInteger030(limit, 18446744073709551615n).toString() } } };
    }
    return value;
  });
  return { kind: 'ready', revision: page.cursor, value: requests };
}

/** Bind readback to an exact captured human scope. Reading never acknowledges. */
export function createHumanReadAccess030(scope: HumanScope030,
  transport: HumanReadTransport030 = { readExecutionHumans030, readExecutionSnapshot030, submitExecutionHuman030 }) {
  const expected = structuredClone(scope);
  const read: ReadHuman030 = async target => {
    if (!target.requestId || !sameHumanScope030(target.scope, expected))
      throw new MacroServiceError('SCOPE_INVALID', 'Human read scope differs');
    const capture = await transport.readExecutionSnapshot030(expected.systemStartId);
    if (!sameHumanScope030({ systemStartId: capture.systemStartId, source: capture.source }, expected))
      throw new MacroServiceError('CORRELATION', 'Human capture differs');
    const facts = await readHumanFacts030(expected, transport.readExecutionHumans030);
    if (facts.kind !== 'ready') throw new MacroServiceError('DTO_UNAVAILABLE', 'Human facts unavailable');
    const request = facts.value.find(request => request.id === target.requestId);
    if (!request) throw new MacroServiceError('NOT_FOUND', 'Human request not found');
    return request;
  };
  const submit: SubmitHuman030 = async input => {
    if (!sameHumanScope030(input.scope, expected)) return { kind: 'refused', refusal: {
      code: 'SCOPE_INVALID', message: 'Human scope differs', currentRevision: null } };
    let receiptId: string;
    try { receiptId = await (transport.submitExecutionHuman030 ?? submitExecutionHuman030)(input); }
    catch (error) {
      const failure = toServiceError(error);
      if (['INPUT_LIMIT', 'INPUT_CONSTRAINT', 'CORRELATION', 'CONFLICT', 'REVISION_CONFLICT'].includes(failure.code))
        return { kind: 'refused', refusal: { code: 'INPUT_CONSTRAINT', message: failure.message, currentRevision: null } };
      return { kind: 'uncertain', code: 'UNCERTAIN', receiptId: null };
    }
    const current = await read({ scope: input.scope, requestId: input.requestId });
    return { kind: 'received', receipt: { scope: input.scope, requestId: input.requestId,
      receiptId, revision: current.revision, state: current.state } };
  };
  return { read, submit };
}

export function createNativeHumanRequestClient030(scope: HumanScope030, storage: HumanDraftStorage030,
  transport?: HumanReadTransport030) {
  return createHumanRequestClient030({ ...createHumanReadAccess030(scope, transport), storage });
}

export const createReadOnlyHumanRequestClient030 = createNativeHumanRequestClient030;
