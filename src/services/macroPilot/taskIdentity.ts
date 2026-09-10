import { PilotStartPreflightRejection } from './startEligibility';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PilotError } from './protocol';

/** Keep existing wire identities; encode branch-qualified local IDs without
 * truncating them or losing the branch that selects the local task. */
export function pilotTaskId(localId: string): string {
  if (!localId?.trim()) throw new PilotError('validation_failed');
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(localId)
    ? localId
    : `task:sha256:${bytesToHex(sha256(new TextEncoder().encode(localId)))}`;
}

export function findPilotTask<T extends { id: string }>(tasks: readonly T[], wireId: string): T | undefined {
  const matches = tasks.filter(task => pilotTaskId(task.id) === wireId);
  if (matches.length > 1) throw new PilotError('invalid_reference');
  return matches[0];
}

export function resolvePilotTask<T extends { id: string }>(tasks: readonly T[], wireId: string): T {
  const task = findPilotTask(tasks, wireId);
  if (!task) throw new PilotError('invalid_reference');
  return task;
}

/** This synchronous lookup runs before any local start effect. */
export function resolvePilotStartTask<T extends { id: string }>(tasks: readonly T[], wireId: string): T {
  try { return resolvePilotTask(tasks, wireId); }
  catch (error) {
    if (error instanceof PilotError && error.code === 'invalid_reference') throw new PilotStartPreflightRejection('invalid_reference');
    throw error;
  }
}
