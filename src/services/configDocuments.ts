import { useConfigStore, selectEffectiveConfigDocument } from '../stores/useConfigStore';
import type {
  ConfigChangeSource,
  ConfigDocument,
  ConfigDocumentKind,
  ConfigPatchResult,
  ConfigScope,
  JsonPatchOperation,
} from '../types/generated/config';
import { createKeyedSerialQueue } from './serialQueue';

const enqueueDocumentMutation = createKeyedSerialQueue<string>();

const documentMutationKey = (kind: ConfigDocumentKind, scope: ConfigScope): string =>
  scope.type === 'project'
    ? `${kind}:project:${scope.projectId}`
    : `${kind}:${scope.type}`;

export const mutateConfigDocument = <T>(
  kind: ConfigDocumentKind,
  scope: ConfigScope,
  mutation: (document: ConfigDocument) => Promise<T>,
): Promise<T> => enqueueDocumentMutation(
  documentMutationKey(kind, scope),
  async () => {
    const document = await useConfigStore.getState().getDocument(kind, scope);
    return mutation(document);
  },
);

type ConfigTopLevelUpdate = unknown | ((currentValue: unknown, document: ConfigDocument) => unknown);

export const patchConfigTopLevel = (
  kind: ConfigDocumentKind,
  scope: ConfigScope,
  key: string,
  update: ConfigTopLevelUpdate,
  source: ConfigChangeSource = 'userInterface',
): Promise<ConfigPatchResult> => mutateConfigDocument(kind, scope, async (document) => {
  const documentValue = document.value && typeof document.value === 'object'
    ? document.value as Record<string, unknown>
    : {};
  const value = typeof update === 'function'
    ? update(documentValue[key], document)
    : update;
  const patch: JsonPatchOperation[] = [{
    op: 'add',
    path: `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
    value,
    from: null,
  }];
  return useConfigStore.getState().patch({
    kind,
    scope,
    expectedEtag: document.etag,
    source,
    patch,
  });
});

export const getEffectiveConfigDocument = async <T extends Record<string, unknown>>(
  kind: ConfigDocumentKind,
): Promise<T> => {
  const snapshot = await useConfigStore.getState().hydrate();
  return selectEffectiveConfigDocument<T>(snapshot, kind) ?? ({} as T);
};

export const patchUserConfigTopLevel = async (
  kind: ConfigDocumentKind,
  key: string,
  value: unknown,
  source: ConfigChangeSource = 'userInterface',
): Promise<ConfigPatchResult> => {
  return patchConfigTopLevel(kind, { type: 'user' }, key, value, source);
};
