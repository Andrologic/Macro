/** diagnostics IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type {
  AppDiagnosticReportPreviewDto,
  FrontendLogParams,
} from "./diagnostics.types";

export async function frontendLog(params: FrontendLogParams): Promise<void> {
  return invoke<void>("frontend_log", {
    level: params.level,
    scope: params.scope,
    message: params.message,
  });
}

export async function appDiagnosticGenerate(): Promise<AppDiagnosticReportPreviewDto> {
  return invoke<AppDiagnosticReportPreviewDto>('app_diagnostic_generate');
}

export async function appDiagnosticSave(reportId: string, path: string): Promise<void> {
  return invoke<void>('app_diagnostic_save', { reportId, path });
}
