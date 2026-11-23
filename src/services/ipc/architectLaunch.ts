import { invoke } from "../tauriRuntimeBridge";
import type { EngineSourceOwner, EngineSourceRevision } from "../../types/generated/ipc";
import type { ImportPreview, VersionKey } from "./architectLibrary";

export const ARCHIVE_RUN_PROJECT = "macro:architect-archive";

export interface LaunchConfiguration {
  workingFolder: string | null;
}

export type LaunchModelOverrides = Readonly<Record<string, { name: string; effort?: string }>>;

export interface LaunchSecret {
  server: string;
  name: string;
  stored: boolean;
}

export interface LaunchPreview {
  version: VersionKey;
  note: string | null;
  startMessageRequired: boolean;
  startMessageHint: string | null;
  workingFolderMode: "perExecution" | "atLaunch";
  configuration: LaunchConfiguration;
  folderInUse: boolean;
  blockers: Array<{ code: string; subject: string }>;
  availableModels: string[];
  permissions: ImportPreview;
  consentToken: string | null;
  secrets: LaunchSecret[];
}

export interface LaunchRequest {
  version: VersionKey;
  configuration: LaunchConfiguration;
  startMessage: string | null;
  name: string | null;
  consentToken: string | null;
  confirmFolderReuse: boolean;
  modelOverrides: LaunchModelOverrides;
}

interface LaunchReceipt {
  identity: { systemStartId: string; snapshotId: string };
  source: EngineSourceRevision;
}

export interface ArchiveRunRecord {
  owner: EngineSourceOwner;
  systemLabel: string;
  systemStartId: string;
  version: VersionKey;
  runName: string | null;
}

export const architectLaunch = {
  prepare: (version: VersionKey, configuration?: LaunchConfiguration, modelOverrides?: LaunchModelOverrides) =>
    invoke<LaunchPreview>("architect_launch_prepare", {
      version, configuration: configuration ?? null, modelOverrides: modelOverrides ?? null,
    }),
  start: (request: LaunchRequest) => invoke<LaunchReceipt>("architect_launch_start", { request }),
  setSecret: (version: VersionKey, server: string, name: string, value: string) =>
    invoke<void>("architect_launch_set_secret", { version, server, name, value }),
  runRecords: () => invoke<ArchiveRunRecord[]>("architect_launch_run_systems"),
  openFolder: (systemStartId: string) => invoke<void>("architect_launch_open_folder", { systemStartId }),
};
