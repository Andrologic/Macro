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
  project?: ProjectView;
  history: BlueprintHistory | null;
  storageState?: "draft" | "recovery";
  diagnostics?: string[];
}
export interface BlueprintConversationResolution extends BlueprintSummary {
  draftRecovery?: { fromConversationId: string; toConversationId: string; owned: boolean } | null;
}
export interface BlueprintVersionSummary extends VersionKey {
  revision: number;
  note: string | null;
  storageState?: "archive" | "recovery";
  createdAt?: string;
}
export interface BlueprintVersion extends BlueprintVersionSummary {
  project?: ProjectView;
  document: BlueprintDocument;
  diagnostics?: string[];
}
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

export interface MacroProjectSettings {
  schemaVersion: 1;
  hiddenAgentIds: string[];
  /** Agent identifier → the name its author gave it. AgSDL itself has only the identifier, which also names the files. */
  agentNames?: Record<string, string>;
  entryMessageHint?: string | null;
  workingFolderMode: "perExecution" | "atLaunch";
  startMessageRequired?: boolean | null;
  launchFields?: unknown;
}

export type MacroSettingsChange = Partial<Pick<MacroProjectSettings, "hiddenAgentIds" | "agentNames" | "entryMessageHint" | "workingFolderMode" | "startMessageRequired" | "launchFields">>;

export type ProjectTarget =
  | { kind: "draft"; blueprintId: string; revision: number }
  | { kind: "version"; key: VersionKey };

export interface ProjectFileEntry { path: string; size: number; executable: boolean }
export type ProjectFile =
  | { kind: "text"; file: ProjectFileEntry; text: string }
  | { kind: "binary" | "oversized"; file: ProjectFileEntry };

export type ProjectFileChange =
  | { kind: "write"; path: string; text: string; executable?: boolean }
  | { kind: "remove"; path: string };

export interface ProjectBatch {
  files: ProjectFileChange[];
  settings?: MacroSettingsChange;
  discardMigrationFiles?: string[];
}
export interface ProjectLocation { file: string; pointer: string }
export interface ProjectDiagnostic {
  code: string;
  file: string | null;
  pointer: string;
  message: string;
  source?: { kind: "io" | "invalidContent"; path?: string };
}

export interface ProjectView {
  revision: number;
  files: ProjectFileEntry[];
  settings: MacroProjectSettings;
  projection: { source: string; origins: Record<string, ProjectLocation> } | null;
  diagnostics: ProjectDiagnostic[];
}

type Usage = "reachable" | "declaredOnly" | "unknown";
export interface ImportPreview {
  title: string | null;
  authoredId: string;
  contract: string;
  packageFormat: "agsdl-project-1" | "agsdl-archive-1";
  projectFormat: "agsdl-project-1";
  stagedSha256: string;
  historyWillBeRemoved: boolean;
  entryPoint: string | null;
  agents: Record<string, {
    usage: Usage; harness: string; harnessVersion: string | null;
    model: { name: string | null; effort: string | null } | null;
    permissions: { preset: string | null; directories: Record<string, string>; outside: string | null;
      reviewer: string | null; rules: { action: string; match: string | null; effect: string }[] };
    mcpServers: string[]; completionCheck: string | null; completionCheckChoices?: string[];
    completionCheckMaxFailures?: string;
  }>;
  directCalls: { location: ProjectLocation; usage: Usage;
    target: { type: "shell"; command: string } | { type: "mcp"; server: string; tool: string } }[];
  mcpServers: Record<string, { usage: Usage; transport: { type: "local"; command: string[] } | { type: "remote"; url: string };
    packagedFiles: string[]; requiredSecrets: string[] }>;
  files: ProjectFileEntry[];
  externalReferences: { uri: string; kind: "content" | "skill" | "mcpEndpoint"; usage: Usage; location: ProjectLocation }[];
  warnings: { code: string; message: string; launchBlocker: boolean; location: ProjectLocation }[];
}

export interface InspectedImport { handle: string; preview: ImportPreview }
export interface ImportedProject { draft: BlueprintDraft; version: BlueprintVersionSummary | null }

type OpenResponse<T> = T | (Omit<T, "document"> & { project: ProjectView });
function opened<T extends { document: BlueprintDocument }>(record: OpenResponse<T>): T {
  if ("document" in record) return record;
  return { ...record, document: { source: record.project.projection?.source ?? "", annexes: {} } } as unknown as T;
}

export function architectProjectDiagnostic(error: unknown): ProjectDiagnostic | undefined {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ARCHITECT_PROJECT_ERROR"
      || !("details" in error) || !error.details || typeof error.details !== "object" || !("code" in error.details)) return;
  return error.details as ProjectDiagnostic;
}

export const architectLibrary = {
  migrateLegacy: () => invoke<LegacyImportReport>("architect_migrate_legacy", {
    localStorage: snapshotLegacyLocalStorage(),
  }),
  listProjects: () => invoke<ArchitectProject[]>("architect_list_projects"),
  createProject: (name: string) => invoke<ArchitectProject>("architect_create_project", { name }),
  listBlueprints: (projectId: string) => invoke<BlueprintSummary[]>("architect_list_blueprints", { projectId }),
  createBlueprint: (projectId: string, name: string, document: BlueprintDocument) =>
    invoke<OpenResponse<BlueprintDraft>>("architect_create_blueprint", { projectId, name, document }).then(opened<BlueprintDraft>),
  getDraft: (blueprintId: string) => invoke<OpenResponse<BlueprintDraft>>("architect_get_draft", { blueprintId }).then(opened<BlueprintDraft>),
  ensureConversation: (blueprintId: string) =>
    invoke<BlueprintConversationResolution>("architect_ensure_conversation", { blueprintId }),
  attachConversation: (blueprintId: string, conversationId: string) =>
    invoke<BlueprintSummary>("architect_attach_conversation", { blueprintId, conversationId }),
  saveDraft: (blueprintId: string, expectedRevision: number, document: BlueprintDocument) =>
    invoke<BlueprintDraft>("architect_save_draft", { blueprintId, expectedRevision, document }),
  saveProjectDraft: (blueprintId: string, expectedRevision: number, batch: ProjectBatch) =>
    invoke<ProjectView>("architect_save_draft", { blueprintId, expectedRevision, batch }),
  validateDraft: (blueprintId: string, expectedRevision: number, batch: ProjectBatch) =>
    invoke<ProjectView>("architect_validate_draft", { blueprintId, expectedRevision, batch }),
  readProjectFile: (target: ProjectTarget, path: string) =>
    invoke<{ revision: number; content: ProjectFile }>("architect_read_project_file", { target, path }),
  inspectImport: (path: string) => invoke<InspectedImport>("architect_inspect_import", { path }),
  discardImport: (handle: string) => invoke<void>("architect_discard_import", { handle }),
  executionHiddenAgents: (executionId: string) =>
    invoke<string[]>("architect_execution_hidden_agents", { executionId }),
  async commitImport(handle: string, projectId: string, name: string): Promise<ImportedProject> {
    const result = await invoke<{ draft: OpenResponse<BlueprintDraft>; version: BlueprintVersionSummary | null }>(
      "architect_commit_import", { handle, projectId, name });
    return { ...result, draft: opened(result.draft) };
  },
  exportArchive: (key: VersionKey, destination: string) =>
    invoke<string>("architect_export_archive", { key, destination }),
  exportProject: (target: ProjectTarget, destination: string) =>
    invoke<number>("architect_export_project", { target, destination }),
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
  exportOriginalEnvelope: (blueprintId: string, revision: number, number: number | null, destination: string) =>
    invoke<void>("architect_export_original_envelope", { blueprintId, revision, number, destination }),
  listVersions: (blueprintId: string) => invoke<BlueprintVersionSummary[]>("architect_list_versions", { blueprintId }),
  getVersion: (key: VersionKey) => invoke<OpenResponse<BlueprintVersion>>("architect_get_version", { key }).then(opened<BlueprintVersion>),
  deleteVersion: (key: VersionKey) => invoke<void>("architect_delete_version", { key }),
  adaptRecoveryDraft: (blueprintId: string, expectedRevision: number, projectId: string, name: string) =>
    invoke<OpenResponse<BlueprintDraft>>("architect_adapt_recovery_draft", { blueprintId, expectedRevision, projectId, name }).then(opened<BlueprintDraft>),
  adaptVersion: (key: VersionKey, projectId: string, name: string) =>
    invoke<OpenResponse<BlueprintDraft>>("architect_adapt_version", { key, projectId, name }).then(opened<BlueprintDraft>),
  recordUse: (key: VersionKey, usage: BlueprintUse) => invoke<void>("architect_record_use", { key, usage }),
  releaseUse: (key: VersionKey, usage: BlueprintUse) => invoke<void>("architect_release_use", { key, usage }),
  listUses: (key: VersionKey) => invoke<BlueprintUse[]>("architect_list_uses", { key }),
  importBlueprint: (input: BlueprintImport) => invoke<BlueprintImportResult>("architect_import_blueprint", { input }),
};
