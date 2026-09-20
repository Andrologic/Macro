/** updates IPC DTOs. Kept separate for generated Rust binding integration. */

export interface NativeStagedUpdateDto {
  currentVersion: string;
  version: string;
  date: string | null;
  notes: string;
  target: string;
  sha256: string;
  packageSize: number;
  phase: 'staged' | 'activating' | 'failed';
  activationAttempts: number;
  error: string | null;
}

export interface NativeAppUpdateSnapshotDto {
  currentVersion: string;
  update: NativeStagedUpdateDto | null;
}
