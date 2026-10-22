export interface DocumentReport {
  contract: "agsdl-0.2.0";
  valid: boolean;
  scope: "parse" | "document-shape-and-declared-references";
  executionSupport: "not-assessed";
  findings: Array<{ code: string; path: string; invocation?: string; message?: string }>;
  [key: string]: unknown;
}
export function read(bytes: Uint8Array): DocumentReport;
