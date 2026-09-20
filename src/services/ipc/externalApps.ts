/** externalApps IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type {
  ExternalAppCatalogDto,
  ExternalOpenAction,
} from "./externalApps.types";

export async function openExternalTarget(params: {
  targetPath: string;
  action: ExternalOpenAction;
  appId: string;
}): Promise<void> {
  return invoke("open_external_target", {
    targetPath: params.targetPath,
    action: params.action,
    appId: params.appId,
  });
}

export async function listExternalApps(): Promise<ExternalAppCatalogDto> {
  return invoke<ExternalAppCatalogDto>("list_external_apps");
}
