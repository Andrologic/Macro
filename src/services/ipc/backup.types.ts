/** backup IPC DTOs. Kept separate for generated Rust binding integration. */

export interface LocalBackupStatus {
  code?: 'exported' | 'restored' | 'rolledBack' | 'failed' | 'invalidRequest' | null;
  path?: string | null;
  /** Raw diagnostic, including messages written by earlier versions. */
  message: string;
  browser: Record<string, string> | null;
}
