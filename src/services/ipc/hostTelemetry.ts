/** Native host telemetry IPC wrapper. */
import { invoke } from "../tauriRuntimeBridge";
import type { HostTelemetryDto } from "../../types/generated/ipc";

/** Read one native host sample. The backend shares each sample for five seconds. */
export async function hostTelemetryRead(): Promise<HostTelemetryDto> {
  return invoke<HostTelemetryDto>("host_telemetry_read");
}
