/** backup IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type { LocalBackupStatus } from "./backup.types";

export const localBackupSchedule = (operation: 'export' | 'restore', path: string, browser: Record<string, string>, confirmed: boolean): Promise<void> =>
  invoke('local_backup_schedule', { operation, path, browser, confirmed });

export const localBackupStatus = (): Promise<LocalBackupStatus> => invoke('local_backup_status');

export const localBackupAcknowledge = (): Promise<void> => invoke('local_backup_acknowledge');
