/** database IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type { DbInitializationStatusDto } from "./database.types";

export async function getDatabaseInitializationStatus(): Promise<DbInitializationStatusDto> {
  return invoke<DbInitializationStatusDto>("db_get_initialization_status");
}

export async function retryDatabaseInitialization(): Promise<DbInitializationStatusDto> {
  return invoke<DbInitializationStatusDto>("db_retry_initialize");
}
