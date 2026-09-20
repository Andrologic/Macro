/** diagnostics IPC DTOs. Kept separate for generated Rust binding integration. */

export type FrontendLogLevel = "debug" | "info" | "warn" | "error";

export interface FrontendLogParams {
  level: FrontendLogLevel;
  scope: string;
  message: string;
}

export interface AppDiagnosticReportPreviewDto {
  reportId: string;
  suggestedFileName: string;
  content: string;
}
