/** updates IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type { NativeAppUpdateSnapshotDto } from "./updates.types";

export async function updaterTarget(): Promise<string> {
  return invoke<string>("updater_target");
}

export async function appUpdateStatus(): Promise<NativeAppUpdateSnapshotDto> {
  return invoke<NativeAppUpdateSnapshotDto>('app_update_status');
}

export async function appUpdateCheckAndStage(params: {
  target: string;
  allowDowngrades: boolean;
}): Promise<NativeAppUpdateSnapshotDto> {
  return invoke<NativeAppUpdateSnapshotDto>('app_update_check_and_stage', {
    target: params.target,
    allowDowngrades: params.allowDowngrades,
  });
}

export async function appUpdateExitAfterCleanShutdown(): Promise<void> {
  return invoke<void>('app_update_exit_after_clean_shutdown');
}

export async function appExitCleanly(): Promise<void> {
  return invoke<void>('app_exit_cleanly');
}

export async function appUpdateDiscard(): Promise<void> {
  return invoke<void>('app_update_discard');
}

export async function appUpdateInstallNow(): Promise<void> {
  return invoke<void>('app_update_install_now');
}

export async function appInstallerCloseRequestPending(): Promise<boolean> {
  return invoke<boolean>('app_installer_close_request_pending');
}

export async function appInstallerCloseRespond(accepted: boolean): Promise<void> {
  return invoke<void>('app_installer_close_respond', { accepted });
}
