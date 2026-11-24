import type { TFunction } from "i18next";
import { architectProjectDiagnostic, type ProjectDiagnostic } from "../../services/ipc/architectLibrary";
import i18n from "../../i18n";
import { AgsdlUserError } from "../../services/agsdl/userErrors";

export function agsdlProjectIssueText(issue: ProjectDiagnostic, t: TFunction): string {
  return issue.code === "MCP_SECRET_RESERVED" ? t("agsdl.library.reservedMcpSecret", { ns: "agsdl" }) : issue.message;
}

export function reservedMcpSecretText(t: TFunction, file?: string | null, pointer?: string): string {
  const message = t("agsdl.library.reservedMcpSecret", { ns: "agsdl" });
  return file ? `${message} ${file}${pointer ? `#${pointer}` : ""}` : message;
}

/** Localize actionable AgSDL errors and use a retry hint for transport failures. */
export function agsdlErrorText(error: unknown, t: TFunction = i18n.getFixedT(null, "agsdl"), fallbackKey = "agsdl.actionFailed"): string {
  const diagnostic = architectProjectDiagnostic(error);
  if (diagnostic) {
    switch (diagnostic.code) {
      case "MCP_SECRET_RESERVED": return reservedMcpSecretText(t, diagnostic.file, diagnostic.pointer);
      case "INPUT_LIMIT":
      case "EDITOR_LIMIT": return t("agsdl.library.projectLimit");
      case "INVALID_LAUNCH_FIELDS": return t("agsdl.launch.fields.invalidDefinition");
      case "OPAQUE_PROJECT_FILE": return t("agsdl.library.opaqueFile");
      case "PROJECT_FILE_NOT_FOUND": return t("agsdl.library.fileMissing");
      case "PROJECT_BATCH_REQUIRED": return t("agsdl.library.projectBatchRequired");
      case "LEGACY_LIBRARY": return t("agsdl.library.cutoverRequired");
      case "IMPORT_HANDLE_EXPIRED": return t("agsdl.library.importExpired");
      case "DESTINATION_PARENT_MISSING": return t("agsdl.library.destinationParentMissing", { path: diagnostic.file });
      case "DESTINATION_EXISTS": return t("agsdl.library.destinationExists");
      case "ARCHIVE_LAYOUT":
      case "ARCHIVE_INTEGRITY":
      case "PROJECT":
      case "UNSUPPORTED_SOURCE":
      case "GRAPH_LIMIT": return t("agsdl.library.projectInvalid");
    }
  }
  if (error instanceof AgsdlUserError) return t(error.messageKey, { details: error.details });
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.startsWith("agsdl.") && i18n.exists(message, { ns: "agsdl" })) return t(message);
  return t(fallbackKey);
}
