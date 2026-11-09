import type { RunHumanRequest030, RunRead030 } from '../../types/agsdlRunUi030';
import type { HumanScope030 } from '../../types/generated/ipc';
import { readExecutionHumans030, readExecutionSnapshot030 } from '../tauriIpc';
import { MacroServiceError, toServiceError } from '../contracts/errors';
import { createHumanRequestClient030, loadHumanRequests030 } from './humanRequests030';
import type { HumanDraftStorage030, ReadHuman030, SubmitHuman030 } from './humanRequests030';

export interface HumanReadTransport030 {
  readExecutionHumans030: typeof readExecutionHumans030;
  readExecutionSnapshot030: typeof readExecutionSnapshot030;
}

export const sameHumanScope030 = (a: HumanScope030, b: HumanScope030) =>
  a.systemStartId === b.systemStartId && a.source.revision === b.source.revision &&
  a.source.sourceSha256 === b.source.sourceSha256 &&
  a.source.owner.projectId === b.source.owner.projectId &&
  a.source.owner.planId === b.source.owner.planId && a.source.owner.branch === b.source.owner.branch;

/** The registered reader still uses engine_human_public030, not the true flow.
 * Its boolean-derived revision, missing resolutions and missing clock cannot
 * satisfy RunHumanRequest030, even when it returns an empty complete series.
 * Consume and validate that series without claiming absence of human waits.
 */
export async function readHumanFacts030(scope: HumanScope030,
  read = readExecutionHumans030): Promise<RunRead030<readonly RunHumanRequest030[]>> {
  try {
    await loadHumanRequests030(scope, read, () => true);
  } catch (error) {
    // True-flow captures need not have a legacy Stored row. Its absence says
    // nothing about the true-flow human queue and must not hide the run itself.
    if (toServiceError(error).code !== 'NOT_FOUND') throw error;
  }
  return { kind: 'unavailable', gap: 'human-flow-projection' };
}

/** No native execution_submit_human030 exists. Never use historical decisions. */
export const submitHumanUnqualified030: SubmitHuman030 = async () => ({
  kind: 'refused', refusal: { code: 'CONTRACT_UNSUPPORTED',
    message: 'Envoi humain non qualifié : execution_submit_human030 est indisponible.', currentRevision: null },
});

/** Bind readback to an exact captured human scope. Reading never acknowledges. */
export function createHumanReadAccess030(scope: HumanScope030,
  transport: HumanReadTransport030 = { readExecutionHumans030, readExecutionSnapshot030 }) {
  const expected = structuredClone(scope);
  const read: ReadHuman030 = async target => {
    if (!target.requestId || !sameHumanScope030(target.scope, expected))
      throw new MacroServiceError('SCOPE_INVALID', 'Human read scope differs');
    const capture = await transport.readExecutionSnapshot030(expected.systemStartId);
    if (!sameHumanScope030({ systemStartId: capture.systemStartId, source: capture.source }, expected))
      throw new MacroServiceError('CORRELATION', 'Human capture differs');
    const facts = await readHumanFacts030(expected, transport.readExecutionHumans030);
    throw new MacroServiceError('DTO_UNAVAILABLE', 'La lecture humaine du vrai flow est non qualifiée.', facts);
  };
  return { read, submit: submitHumanUnqualified030 };
}

export function createReadOnlyHumanRequestClient030(scope: HumanScope030, storage: HumanDraftStorage030,
  transport?: HumanReadTransport030) {
  return createHumanRequestClient030({ ...createHumanReadAccess030(scope, transport), storage });
}
