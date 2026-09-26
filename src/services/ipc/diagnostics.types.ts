import type {
DiagnosticReportPreview as NativeAppDiagnosticReportPreviewDto
} from '../../types/generated/ipc';

/** diagnostics IPC contracts and explicit frontend adaptations of generated native bindings. */

export type FrontendLogLevel = "debug" | "info" | "warn" | "error";

export interface FrontendLogParams {
  level: FrontendLogLevel;
  scope: string;
  message: string;
}

export type AppDiagnosticReportPreviewDto = NativeAppDiagnosticReportPreviewDto;
