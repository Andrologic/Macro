import { architectProjectDiagnostic } from "../../services/ipc/architectLibrary";

export type ImportBlockerKey =
  | "invalidArchive" | "integrity" | "unsafePath" | "tooLarge" | "notAProject" | "projectInvalid" | "expired" | "unreadable";

const byCode: Record<string, ImportBlockerKey> = {
  ARCHIVE_LAYOUT: "invalidArchive",
  INVALID_JSON: "invalidArchive",
  ARCHIVE_INTEGRITY: "integrity",
  PROJECT_PATH: "unsafePath",
  ARCHIVE_LIMIT: "tooLarge",
  IMPORT_CANDIDATE_LIMIT: "tooLarge",
  UNSUPPORTED_SOURCE: "notAProject",
  PROJECT: "projectInvalid",
  IMPORT_HANDLE_EXPIRED: "expired",
};

/**
 * Why an import cannot go ahead, in words an author can act on.
 * The native message stays available as technical detail, never as the headline.
 */
export function importBlocker(error: unknown): { key: ImportBlockerKey; technical: string } {
  const diagnostic = architectProjectDiagnostic(error);
  const technical = diagnostic ? [diagnostic.code, diagnostic.message].filter(Boolean).join(" · ")
    : error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return { key: (diagnostic && byCode[diagnostic.code]) || "unreadable", technical };
}
