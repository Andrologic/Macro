import { isTauriEnvironment } from '../utils/isTauriEnvironment';

export const DEFAULT_APP_VERSION = '0.0.0';

export const normalizeAppVersion = (
  value: string | null | undefined,
  fallbackVersion: string = DEFAULT_APP_VERSION
): string => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallbackVersion;
};

export interface LoadAppVersionDependencies {
  fallbackVersion: string;
  isTauriEnvironment: () => boolean;
  getRuntimeVersion: () => Promise<string>;
}

export const buildAppVersion = normalizeAppVersion(import.meta.env.VITE_APP_VERSION);

export const createLoadAppVersion = ({
  fallbackVersion,
  isTauriEnvironment: canUseTauriRuntime,
  getRuntimeVersion,
}: LoadAppVersionDependencies) => {
  return async (): Promise<string> => {
    if (!canUseTauriRuntime()) {
      return fallbackVersion;
    }

    try {
      return normalizeAppVersion(await getRuntimeVersion(), fallbackVersion);
    } catch {
      return fallbackVersion;
    }
  };
};

const getRuntimeVersion = async (): Promise<string> => {
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
};

export const loadAppVersion = createLoadAppVersion({
  fallbackVersion: buildAppVersion,
  isTauriEnvironment,
  getRuntimeVersion,
});
