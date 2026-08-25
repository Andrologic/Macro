import { useConfigStore, selectEffectiveConfigDocument } from '../stores/useConfigStore';
import type {
  ConfigChangeSource,
  ConfigDocumentKind,
  ConfigPatchResult,
} from '../types/generated/config';

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
  const store = useConfigStore.getState();
  const document = await store.getDocument(kind);
  return store.patch({
    kind,
    expectedEtag: document.etag,
    source,
    patch: [{
      op: 'add',
      path: `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
      value,
      from: null,
    }],
  });
};
