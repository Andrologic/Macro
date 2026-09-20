/** state IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type { StateSnapshotDto } from "./state.types";

export async function stateGetSnapshot(): Promise<StateSnapshotDto> {
  return invoke<StateSnapshotDto>("state_get_snapshot");
}

export async function stateSetValue(
  key: string,
  value: unknown,
): Promise<StateSnapshotDto> {
  return invoke<StateSnapshotDto>("state_set_value", { key, value });
}

export async function stateDeleteValue(key: string): Promise<StateSnapshotDto> {
  return invoke<StateSnapshotDto>("state_delete_value", { key });
}

export async function stateClear(): Promise<StateSnapshotDto> {
  return invoke<StateSnapshotDto>("state_clear");
}
