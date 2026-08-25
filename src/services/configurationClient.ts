import type {
  ConfigDocument,
  ConfigDocumentKind,
  ConfigPatchRequest,
  ConfigPatchResult,
  ConfigScope,
  ConfigSnapshot,
  ConfigValidationResult,
  PendingSensitiveConfigChange,
} from '../types/generated/config';
import type { AppMode, ReasoningEffort, ToolRiskLevel } from '../types';
import { remoteRequest, resolveRemoteConfig } from './providers/remoteHttp';
import type { OrphanSecretDto } from './tauriIpc';
import * as tauriIpc from './tauriIpc';
import { normalizeReasoningEffortValue } from './reasoningCatalog';

const isNativeConfigClientAvailable = (): boolean =>
  (tauriIpc.isTauriAvailable?.() ?? false)
  && typeof tauriIpc.configGetSnapshot === 'function'
  && typeof tauriIpc.configGetDocument === 'function'
  && typeof tauriIpc.configApplyPatch === 'function';

export const isConfigurationClientAvailable = (): boolean =>
  isNativeConfigClientAvailable() || resolveRemoteConfig() !== null;

export const configurationGetSnapshot = (projectIds: string[] = []): Promise<ConfigSnapshot> =>
  isNativeConfigClientAvailable()
    ? tauriIpc.configGetSnapshot(projectIds)
    : remoteRequest<ConfigSnapshot>('/config/snapshot', {
        method: 'POST',
        body: JSON.stringify({ projectIds }),
      });

export interface ScopedTurnConfiguration {
  projectIds: string[];
  focusProjectId: string | null;
  riskLevel: ToolRiskLevel;
  maxTurns: number | null;
  models: Readonly<Record<string, ScopedModelSelection>>;
  builtInTools: Readonly<Record<string, boolean>>;
  modeTools: Readonly<Record<string, boolean>>;
  allowedMcpServerIds: readonly string[];
  mcpServers: Readonly<Record<string, Record<string, unknown>>>;
}

export interface ScopedModelSelection {
  providerId: string;
  modelId: string;
  reasoningEffort: ReasoningEffort | null;
}

const asBooleanMap = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    ),
  );
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const asModelSelections = (value: unknown): Record<string, ScopedModelSelection> => {
  const selections: Record<string, ScopedModelSelection> = {};
  for (const [key, candidate] of Object.entries(asRecord(value))) {
    const selection = asRecord(candidate);
    if (typeof selection.providerId !== 'string' || typeof selection.modelId !== 'string') {
      continue;
    }
    const reasoningEffort = normalizeReasoningEffortValue(selection.reasoningEffort);
    selections[key] = {
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoningEffort,
    };
  }
  return selections;
};

const normalizeProjectIds = (projectIds: string[]): string[] =>
  Array.from(new Set(projectIds.map((id) => id.trim()).filter(Boolean))).sort();

const getEnabledMcpServerIds = (tools: Record<string, unknown>): Set<string> => {
  const servers = asRecord(tools.mcpServers);
  return new Set(
    Object.entries(servers)
      .filter(([, value]) => asRecord(value).enabled === true)
      .map(([serverId]) => serverId),
  );
};

const resolveAllowedMcpServerIds = (
  snapshot: ConfigSnapshot,
  projectIds: string[],
): string[] => {
  const globallyEnabled = getEnabledMcpServerIds(asRecord(snapshot.effective.tools));
  if (projectIds.length === 0) return [...globallyEnabled].sort();
  const globalServers = asRecord(asRecord(snapshot.effective.tools).mcpServers);

  const projectServerSets = projectIds.map((projectId) => {
    const projectEffective = snapshot.projectEffective[projectId];
    return projectEffective
      ? getEnabledMcpServerIds(asRecord(projectEffective.tools))
      : new Set<string>();
  });

  const firstProjectServers = projectServerSets[0] ?? new Set<string>();
  return [...firstProjectServers]
    .filter((serverId) => !(serverId in globalServers) || globallyEnabled.has(serverId))
    .filter((serverId) => projectServerSets.slice(1).every((servers) => servers.has(serverId)))
    .sort();
};

const resolveScopedMcpServers = (
  snapshot: ConfigSnapshot,
  projectIds: string[],
  allowedServerIds: readonly string[],
): Record<string, Record<string, unknown>> => {
  const toolDocuments = projectIds.length === 0
    ? [asRecord(snapshot.effective.tools)]
    : projectIds.map((projectId) => asRecord(snapshot.projectEffective[projectId]?.tools));
  const serverMaps = toolDocuments.map((tools) => asRecord(tools.mcpServers));
  const result: Record<string, Record<string, unknown>> = {};
  for (const serverId of allowedServerIds) {
    const definitions = serverMaps.map((servers) => asRecord(servers[serverId]));
    const canonical = JSON.stringify(definitions[0] ?? {});
    if (definitions.slice(1).some((definition) => JSON.stringify(definition) !== canonical)) {
      continue;
    }
    result[serverId] = definitions[0] ?? {};
  }
  return result;
};

export const resolveScopedTurnConfiguration = (
  snapshot: ConfigSnapshot,
  context: {
    projectIds: string[];
    focusProjectId?: string | null;
    mode: AppMode;
  },
): ScopedTurnConfiguration => {
  const projectIds = normalizeProjectIds(context.projectIds);
  const focusProjectId =
    context.focusProjectId && projectIds.includes(context.focusProjectId)
      ? context.focusProjectId
      : projectIds.length === 1
        ? projectIds[0]
        : null;
  const tools = asRecord(snapshot.effective.tools);
  const agents = asRecord(snapshot.effective.agents);
  const focusedProject = focusProjectId
    ? snapshot.projectEffective[focusProjectId]
    : undefined;
  const focusedAgents = focusedProject ? asRecord(focusedProject.agents) : agents;
  const modes = asRecord(tools.modes);
  const rawRiskLevel = tools.riskLevel;
  const riskLevel: ToolRiskLevel =
    rawRiskLevel === 'strict' || rawRiskLevel === 'yolo' ? rawRiskLevel : 'balanced';
  const rawMaxTurns = agents.maxTurns;
  const maxTurns =
    typeof rawMaxTurns === 'number' && Number.isInteger(rawMaxTurns) && rawMaxTurns > 0
      ? rawMaxTurns
      : null;
  const allowedMcpServerIds = resolveAllowedMcpServerIds(snapshot, projectIds);
  const mcpServers = resolveScopedMcpServers(snapshot, projectIds, allowedMcpServerIds);

  return {
    projectIds,
    focusProjectId,
    riskLevel,
    maxTurns,
    models: asModelSelections(focusedAgents.models),
    builtInTools: asBooleanMap(tools.builtIn),
    modeTools: asBooleanMap(modes[context.mode]),
    allowedMcpServerIds: Object.keys(mcpServers).sort(),
    mcpServers,
  };
};

export const resolveScopedModelSelection = (
  config: ScopedTurnConfiguration | null,
  preferenceKeys: readonly string[],
): ScopedModelSelection | null => {
  if (!config) return null;
  for (const key of preferenceKeys) {
    const selection = config.models[key];
    if (selection) return selection;
  }
  return null;
};

export const loadScopedTurnConfiguration = async (context: {
  projectIds: string[];
  focusProjectId?: string | null;
  mode: AppMode;
}, snapshotLoader?: (projectIds: string[]) => Promise<ConfigSnapshot>): Promise<ScopedTurnConfiguration | null> => {
  if (!snapshotLoader && !isConfigurationClientAvailable()) return null;
  const projectIds = normalizeProjectIds(context.projectIds);
  const snapshot = await (snapshotLoader ?? configurationGetSnapshot)(projectIds);
  return resolveScopedTurnConfiguration(snapshot, { ...context, projectIds });
};

export const applyScopedToolRestrictions = (
  toolIds: string[],
  config: ScopedTurnConfiguration | null,
): string[] => {
  if (!config) return toolIds;
  return toolIds.filter(
    (toolId) => config.builtInTools[toolId] !== false && config.modeTools[toolId] !== false,
  );
};

export const configurationGetDocument = (
  kind: ConfigDocumentKind,
  scope: ConfigScope = { type: 'user' },
): Promise<ConfigDocument> => isNativeConfigClientAvailable()
  ? tauriIpc.configGetDocument(kind, scope)
  : remoteRequest<ConfigDocument>('/config/document', {
      method: 'POST',
      body: JSON.stringify({ kind, scope }),
    });

export const configurationApplyPatch = (
  request: ConfigPatchRequest,
): Promise<ConfigPatchResult> => isNativeConfigClientAvailable()
  ? request.source === 'agent'
    ? tauriIpc.configApplyAgentPatch(request)
    : tauriIpc.configApplyPatch(request)
  : remoteRequest<ConfigPatchResult>('/config/patch', {
      method: 'POST',
      body: JSON.stringify({
        kind: request.kind,
        scope: request.scope,
        expectedEtag: request.expectedEtag,
        patch: request.patch,
      }),
    });

export const configurationValidateDocument = (input: {
  kind: ConfigDocumentKind;
  scope?: ConfigScope;
  document: unknown;
}): Promise<ConfigValidationResult> => isNativeConfigClientAvailable()
  ? tauriIpc.configValidateDocument(input)
  : remoteRequest<ConfigValidationResult>('/config/validate', {
      method: 'POST',
      body: JSON.stringify({
        kind: input.kind,
        scope: input.scope ?? { type: 'user' },
        document: input.document,
      }),
    });

export const configurationReload = (input: {
  kind: ConfigDocumentKind;
  scope?: ConfigScope;
}): Promise<ConfigDocument> => isNativeConfigClientAvailable()
  ? tauriIpc.configReload(input)
  : remoteRequest<{ document: ConfigDocument }>('/config/reload', {
      method: 'POST',
      body: JSON.stringify({ kind: input.kind, scope: input.scope ?? { type: 'user' } }),
    }).then((outcome) => outcome.document);

export const configurationResetPath = async (input: {
  kind: ConfigDocumentKind;
  scope?: ConfigScope;
  path: string;
  expectedEtag: string;
}): Promise<ConfigPatchResult> => isNativeConfigClientAvailable()
  ? tauriIpc.configResetPath(input)
  : configurationApplyPatch({
      kind: input.kind,
      scope: input.scope ?? { type: 'user' },
      expectedEtag: input.expectedEtag,
      patch: [{ op: 'remove', path: input.path }],
      source: 'userInterface',
    });

export const configurationListPendingChanges = (): Promise<PendingSensitiveConfigChange[]> =>
  isNativeConfigClientAvailable()
    ? tauriIpc.configListPendingChanges()
    : remoteRequest<PendingSensitiveConfigChange[]>('/config/pending');

export const configurationAcceptPendingChange = (id: string): Promise<ConfigDocument> =>
  isNativeConfigClientAvailable()
    ? tauriIpc.configAcceptPendingChange(id)
    : remoteRequest<ConfigDocument>('/config/pending/accept', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });

export const configurationRejectPendingChange = (input: {
  id: string;
  restoreApproved: boolean;
}): Promise<ConfigDocument> => isNativeConfigClientAvailable()
  ? tauriIpc.configRejectPendingChange(input)
  : remoteRequest<ConfigDocument>('/config/pending/reject', {
      method: 'POST',
      body: JSON.stringify(input),
    });

export const configurationListOrphanSecrets = (): Promise<OrphanSecretDto[]> =>
  isNativeConfigClientAvailable()
    ? tauriIpc.configListOrphanSecrets()
    : remoteRequest<OrphanSecretDto[]>('/config/orphan-secrets');

export const configurationDeleteOrphanSecret = (input: {
  id: string;
  secretType: OrphanSecretDto['secretType'];
}): Promise<void> => isNativeConfigClientAvailable()
  ? tauriIpc.configDeleteOrphanSecret(input)
  : remoteRequest<void>('/config/orphan-secrets/delete', {
      method: 'POST',
      body: JSON.stringify(input),
    });

export type { OrphanSecretDto } from './tauriIpc';
