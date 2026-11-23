/** backup IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type { LocalBackupStatus } from "./backup.types";

export const localBackupSchedule = (operation: 'export' | 'restore', path: string, browser: Record<string, string>, confirmed: boolean): Promise<void> =>
  invoke('local_backup_schedule', { operation, path, browser, confirmed });

export const localBackupStatus = (): Promise<LocalBackupStatus> => invoke('local_backup_status');

export const localBackupAcknowledge = (): Promise<void> => invoke('local_backup_acknowledge');

export interface ProfileStartupRecovery {
  kind: 'startup' | 'restore';
  diagnostics: string;
  preservedArchive: string | null;
}

export class ProfileStartupRecoveryError extends Error {
  constructor(readonly recovery: ProfileStartupRecovery) {
    super(recovery.diagnostics);
  }
}

export const getProfileStartupRecovery = (): Promise<ProfileStartupRecovery | null> =>
  invoke('profile_startup_recovery');

export const retryProfileRecovery = (): Promise<void> => invoke('profile_recovery_retry');

export const revealProfileRecovery = (): Promise<void> => invoke('profile_recovery_reveal');
