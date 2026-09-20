/** state IPC DTOs. Kept separate for generated Rust binding integration. */

export interface StateSnapshotDto {
  schemaVersion: number;
  values: Record<string, unknown>;
}
