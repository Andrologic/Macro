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
import { remoteRequest, resolveRemoteConfig } from './providers/remoteHttp';
import type { OrphanSecretDto } from './tauriIpc';
import * as tauriIpc from './tauriIpc';

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
  ? tauriIpc.configApplyPatch(request)
  : remoteRequest<ConfigPatchResult>('/config/patch', {
      method: 'POST',
      body: JSON.stringify(request),
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
