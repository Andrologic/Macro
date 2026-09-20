/** config IPC wrappers and frontend adapters. */

import type {
  ConfigDocument,
  ConfigDocumentKind,
  ConfigPatchRequest,
  ConfigPatchResult,
  ConfigScope,
  ConfigSnapshot,
  ConfigValidationResult,
  PendingSensitiveConfigChange,
} from "../../types/generated/config";
import { invoke } from "../tauriRuntimeBridge";
import type { OrphanSecretDto } from "./config.types";

export async function configGetSnapshot(
  projectIds: string[] = [],
): Promise<ConfigSnapshot> {
  return invoke<ConfigSnapshot>("config_get_snapshot", { projectIds });
}

export async function configGetDocument(
  kind: ConfigDocumentKind,
  scope: ConfigScope = { type: "user" },
): Promise<ConfigDocument> {
  return invoke<ConfigDocument>("config_get_document", { kind, scope });
}

export async function configGetSchema(
  kind: ConfigDocumentKind,
): Promise<unknown> {
  return invoke<unknown>("config_get_schema", { kind });
}

export async function configValidateDocument(input: {
  kind: ConfigDocumentKind;
  scope?: ConfigScope;
  document: unknown;
}): Promise<ConfigValidationResult> {
  return invoke<ConfigValidationResult>("config_validate_document", {
    kind: input.kind,
    scope: input.scope ?? { type: "user" },
    document: input.document,
  });
}

export async function configApplyPatch(
  request: ConfigPatchRequest,
): Promise<ConfigPatchResult> {
  return invoke<ConfigPatchResult>("config_apply_patch", { request });
}

export async function configApplyAgentPatch(
  request: ConfigPatchRequest,
): Promise<ConfigPatchResult> {
  return invoke<ConfigPatchResult>("config_patch", { request });
}

export async function configResetPath(input: {
  kind: ConfigDocumentKind;
  scope?: ConfigScope;
  path: string;
  expectedEtag: string;
}): Promise<ConfigPatchResult> {
  return invoke<ConfigPatchResult>("config_reset_path", {
    kind: input.kind,
    scope: input.scope ?? { type: "user" },
    path: input.path,
    expectedEtag: input.expectedEtag,
  });
}

export async function configReload(input: {
  kind: ConfigDocumentKind;
  scope?: ConfigScope;
}): Promise<ConfigDocument> {
  return invoke<ConfigDocument>("config_reload", {
    kind: input.kind,
    scope: input.scope ?? { type: "user" },
  });
}

export async function configOpenDirectory(input: {
  kind?: ConfigDocumentKind;
  scope?: ConfigScope;
} = {}): Promise<string> {
  return invoke<string>("config_open_directory", {
    kind: input.kind ?? null,
    scope: input.scope ?? { type: "user" },
  });
}

export async function configAcceptPendingChange(
  id: string,
): Promise<ConfigDocument> {
  return invoke<ConfigDocument>("config_accept_pending_change", { id });
}

export async function configRejectPendingChange(input: {
  id: string;
  restoreApproved: boolean;
}): Promise<ConfigDocument> {
  return invoke<ConfigDocument>("config_reject_pending_change", input);
}

export async function configListPendingChanges(): Promise<
  PendingSensitiveConfigChange[]
> {
  return invoke<PendingSensitiveConfigChange[]>(
    "config_list_pending_changes",
  );
}

export async function configListOrphanSecrets(): Promise<OrphanSecretDto[]> {
  return invoke<OrphanSecretDto[]>('config_list_orphan_secrets');
}

export async function configDeleteOrphanSecret(input: {
  id: string;
  secretType: OrphanSecretDto['secretType'];
}): Promise<void> {
  return invoke('config_delete_orphan_secret', { request: input });
}

export async function configAgentList(
  projectIds: string[] = [],
): Promise<ConfigSnapshot> {
  return invoke<ConfigSnapshot>('config_list', { projectIds });
}

export async function configAgentGet(
  kind: ConfigDocumentKind,
  scope: ConfigScope = { type: 'user' },
): Promise<ConfigDocument> {
  return invoke<ConfigDocument>('config_get', { kind, scope });
}

export async function configAgentValidate(input: {
  kind: ConfigDocumentKind;
  scope?: ConfigScope;
  document: unknown;
}): Promise<ConfigValidationResult> {
  return invoke<ConfigValidationResult>('config_validate', {
    kind: input.kind,
    scope: input.scope ?? { type: 'user' },
    document: input.document,
  });
}

export async function configAgentPatch(
  request: Omit<ConfigPatchRequest, 'source'>,
): Promise<ConfigPatchResult> {
  return invoke<ConfigPatchResult>('config_patch', {
    request: { ...request, source: 'agent' },
  });
}
