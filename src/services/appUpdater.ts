import { isTauriEnvironment } from '../utils/isTauriEnvironment';
import i18n from '../i18n';
import {
  appUpdateCheckAndStage,
  appUpdateDiscard,
  appUpdateInstallNow,
  appUpdateStatus,
  updaterTarget,
  type NativeAppUpdateSnapshotDto,
} from './tauriIpc';
import {
  loadUpdateChannel,
  shouldAllowChannelDowngrade,
  type UpdateChannel,
  updaterTargetForChannel,
} from './updateChannels';

export interface AppUpdateMetadata {
  currentVersion: string;
  version: string;
  date: string | null;
  notes: string;
  activationAttempts: number;
  activationError: string | null;
}

export interface AppUpdateCheckResult {
  currentVersion: string;
  update: AppUpdateMetadata | null;
}

export type AppUpdateDownloadEvent =
  | { type: 'started'; contentLength: number | null }
  | { type: 'progress'; chunkLength: number }
  | { type: 'finished' };

export interface AppUpdaterClient {
  status: () => Promise<AppUpdateCheckResult>;
  checkAndDownload: (
    onEvent: (event: AppUpdateDownloadEvent) => void,
  ) => Promise<AppUpdateCheckResult>;
  installAndRelaunch: () => Promise<void>;
  reset: () => Promise<void>;
}

type NativeDownloadEvent =
  | { type: 'started'; contentLength?: number }
  | { type: 'progress'; chunkLength: number }
  | { type: 'finished' };

export interface NativeUpdaterBindings {
  getUpdaterTarget: () => Promise<string>;
  status: () => Promise<NativeAppUpdateSnapshotDto>;
  checkAndStage: (options: {
    target: string;
    allowDowngrades: boolean;
  }) => Promise<NativeAppUpdateSnapshotDto>;
  installNow: () => Promise<void>;
  discard: () => Promise<void>;
  listenForProgress: (
    listener: (event: NativeDownloadEvent) => void,
  ) => Promise<() => void>;
}

export type LoadNativeUpdaterBindings = () => Promise<NativeUpdaterBindings>;
export type LoadUpdateChannel = () => Promise<UpdateChannel>;

export const isAutomaticUpdaterEnabled = (): boolean =>
  import.meta.env.PROD && isTauriEnvironment();

const loadNativeUpdaterBindings: LoadNativeUpdaterBindings = async () => {
  const { listen } = await import('@tauri-apps/api/event');
  return {
    getUpdaterTarget: updaterTarget,
    status: appUpdateStatus,
    checkAndStage: appUpdateCheckAndStage,
    installNow: appUpdateInstallNow,
    discard: appUpdateDiscard,
    listenForProgress: (listener) =>
      listen<NativeDownloadEvent>('app-update://download-progress', (event) => {
        listener(event.payload);
      }),
  };
};

const mapSnapshot = (snapshot: NativeAppUpdateSnapshotDto): AppUpdateCheckResult => ({
  currentVersion: snapshot.currentVersion,
  update: snapshot.update
    ? {
        currentVersion: snapshot.update.currentVersion,
        version: snapshot.update.version,
        date: snapshot.update.date,
        notes: snapshot.update.notes,
        activationAttempts: snapshot.update.activationAttempts,
        activationError: snapshot.update.error,
      }
    : null,
});

export class TauriAppUpdaterClient implements AppUpdaterClient {
  constructor(
    private readonly loadBindings: LoadNativeUpdaterBindings = loadNativeUpdaterBindings,
    private readonly loadChannel: LoadUpdateChannel = loadUpdateChannel,
  ) {}

  async status(): Promise<AppUpdateCheckResult> {
    const bindings = await this.loadBindings();
    return mapSnapshot(await bindings.status());
  }

  async checkAndDownload(
    onEvent: (event: AppUpdateDownloadEvent) => void,
  ): Promise<AppUpdateCheckResult> {
    const bindings = await this.loadBindings();
    const current = await bindings.status();
    const [channel, nativeTarget] = await Promise.all([
      this.loadChannel(),
      bindings.getUpdaterTarget(),
    ]);
    const unlisten = await bindings.listenForProgress((event) => {
      if (event.type === 'started') {
        onEvent({ type: 'started', contentLength: event.contentLength ?? null });
      } else if (event.type === 'progress') {
        onEvent({ type: 'progress', chunkLength: event.chunkLength });
      } else {
        onEvent({ type: 'finished' });
      }
    });
    try {
      const snapshot = await bindings.checkAndStage({
        target: updaterTargetForChannel(channel, nativeTarget),
        allowDowngrades: shouldAllowChannelDowngrade(channel, current.currentVersion),
      });
      return mapSnapshot(snapshot);
    } finally {
      unlisten();
    }
  }

  async installAndRelaunch(): Promise<void> {
    const bindings = await this.loadBindings();
    await bindings.installNow();
  }

  async reset(): Promise<void> {
    const bindings = await this.loadBindings();
    await bindings.discard();
  }
}

export const appUpdaterClient: AppUpdaterClient = new TauriAppUpdaterClient();

export type AppUpdateErrorOperation = 'check' | 'download' | 'install';

export const toAppUpdateErrorMessage = (
  _error: unknown,
  operation: AppUpdateErrorOperation,
): string => {
  if (operation === 'download') {
    return i18n.t('updates.downloadFailed', 'The update could not be downloaded');
  }
  if (operation === 'install') {
    return i18n.t('updates.installFailed', 'The update could not be installed');
  }
  return i18n.t('updates.checkFailed', 'Unable to check for updates');
};
