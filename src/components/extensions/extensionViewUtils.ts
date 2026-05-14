import {
  onExtensionViewRefresh,
  notifyExtensionSelectionChanged,
  normalizeSelectionEnvelope,
  setExtensionViewSelection,
  type MacroExtensionSelectionSource,
} from '../../services/extensionRuntimeApi';

export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const selectExtensionPayload = (
  extensionId: string,
  viewId: string,
  payload: unknown,
  source: MacroExtensionSelectionSource,
): void => {
  const envelope = normalizeSelectionEnvelope(extensionId, viewId, { payload }, source);
  setExtensionViewSelection(extensionId, viewId, envelope);
  void notifyExtensionSelectionChanged(envelope);
};

export const isRefreshForView = (
  targetExtensionId: string,
  targetViewId: string,
  extensionId: string,
  viewId: string,
): boolean =>
  targetExtensionId === extensionId && (targetViewId === viewId || targetViewId === '*');

export const subscribeToExtensionViewRefresh = (
  extensionId: string,
  viewId: string,
  load: () => void,
): { dispose: () => void } =>
  onExtensionViewRefresh((targetExtensionId, targetViewId) => {
    if (isRefreshForView(targetExtensionId, targetViewId, extensionId, viewId)) {
      load();
    }
  });
