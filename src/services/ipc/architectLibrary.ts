import type { AgsdlEditorDocument } from "../../types/agsdl";
import { snapshotLegacyLocalStorage } from "../agsdl/legacyLocalStorage";
import { AgsdlUserError } from "../agsdl/userErrors";
import { invoke } from "../tauriRuntimeBridge";

export const ARCHITECT_LIBRARY_IMPORT_STEP = "Architect library import";

export type BlueprintDocument = Omit<AgsdlEditorDocument, "revision">;
export interface ArchitectProject { id: string; name: string }
export interface VersionKey { blueprintId: string; number: number }
export interface BlueprintSummary {
  id: string;
  projectId: string;
  name: string;
  revision: number;
  origin: VersionKey | null;
  archived: boolean;
  conversationId: string | null;
}
export interface BlueprintHistory {
  status?: string;
  archivedAt?: string;
  archivedFromStatus?: string;
  [key: string]: unknown;
}
export interface BlueprintDraft extends BlueprintSummary {
  document: BlueprintDocument;
  history: BlueprintHistory | null;
}
export interface BlueprintConversationResolution extends BlueprintSummary {
  draftRecovery?: { fromConversationId: string; toConversationId: string; owned: boolean } | null;
}
export interface BlueprintVersionSummary extends VersionKey { revision: number; note: string | null }
export interface BlueprintVersion extends BlueprintVersionSummary { document: BlueprintDocument }
export interface BlueprintImport {
  history?: BlueprintHistory;
  conversationId?: string;
  sourceProjectId: string;
  /** Stable within the source project, including its branch when applicable. */
  sourceId: string;
  projectName: string;
  name: string;
  document: BlueprintDocument;
}
export interface BlueprintImportResult { projectId: string; blueprintId: string; imported: boolean }
export interface BlueprintUse { kind: "execution" | "schedule"; ownerId: string }

export interface LegacyImportReport {
  status: "complete" | "discoveryIncomplete";
  discovered: number;
  inserted: number;
  alreadyImported: number;
  divergentPlans: number;
  issues: Array<{ location: string; message: string }>;
}

export const architectLibrary = {
  migrateLegacy: () => invoke<LegacyImportReport>("architect_migrate_legacy", {
    localStorage: snapshotLegacyLocalStorage(),
  }),
  listProjects: () => invoke<ArchitectProject[]>("architect_list_projects"),
  createProject: (name: string) => invoke<ArchitectProject>("architect_create_project", { name }),
  listBlueprints: (projectId: string) => invoke<BlueprintSummary[]>("architect_list_blueprints", { projectId }),
  createBlueprint: (projectId: string, name: string, document: BlueprintDocument) =>
    invoke<BlueprintDraft>("architect_create_blueprint", { projectId, name, document }),
  getDraft: (blueprintId: string) => invoke<BlueprintDraft>("architect_get_draft", { blueprintId }),
  ensureConversation: (blueprintId: string) =>
    invoke<BlueprintConversationResolution>("architect_ensure_conversation", { blueprintId }),
  attachConversation: (blueprintId: string, conversationId: string) =>
    invoke<BlueprintSummary>("architect_attach_conversation", { blueprintId, conversationId }),
  saveDraft: (blueprintId: string, expectedRevision: number, document: BlueprintDocument) =>
    invoke<BlueprintDraft>("architect_save_draft", { blueprintId, expectedRevision, document }),
  async saveVersion(blueprintId: string, expectedRevision: number, note: string | null = null, editedDraft?: BlueprintDocument) {
    try {
      return await invoke<BlueprintVersionSummary & { convertedDraft?: BlueprintDocument }>("architect_save_version", { blueprintId, expectedRevision, note, editedDraft });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "AGSDL_UPGRADE_INVALID"
        && "message" in error && typeof error.message === "string") {
        throw new AgsdlUserError("agsdl.library.upgradeInvalid", error.message, error.message);
      }
      throw error;
    }
  },
  listVersions: (blueprintId: string) => invoke<BlueprintVersionSummary[]>("architect_list_versions", { blueprintId }),
  getVersion: (key: VersionKey) => invoke<BlueprintVersion>("architect_get_version", { key }),
  deleteVersion: (key: VersionKey) => invoke<void>("architect_delete_version", { key }),
  adaptVersion: (key: VersionKey, projectId: string, name: string) =>
    invoke<BlueprintDraft>("architect_adapt_version", { key, projectId, name }),
  recordUse: (key: VersionKey, usage: BlueprintUse) => invoke<void>("architect_record_use", { key, usage }),
  releaseUse: (key: VersionKey, usage: BlueprintUse) => invoke<void>("architect_release_use", { key, usage }),
  listUses: (key: VersionKey) => invoke<BlueprintUse[]>("architect_list_uses", { key }),
  importBlueprint: (input: BlueprintImport) => invoke<BlueprintImportResult>("architect_import_blueprint", { input }),
};
