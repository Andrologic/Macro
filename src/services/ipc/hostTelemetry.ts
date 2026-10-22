/** Native host telemetry IPC wrapper. */
import { invoke } from "../tauriRuntimeBridge";
import type { HostTelemetryDto } from "../../types/generated/ipc";

/** Read one native host sample. The backend shares each sample for five seconds. */
export async function hostTelemetryRead(): Promise<HostTelemetryDto & { reuseForMs?: number | null }> {
  return invoke<HostTelemetryDto & { reuseForMs?: number | null }>("host_telemetry_read");
}
