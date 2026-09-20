/** database IPC DTOs. Kept separate for generated Rust binding integration. */

export interface DbInitializationStatusDto {
  status: "initializing" | "ready" | "failed";
  message: string | null;
}
