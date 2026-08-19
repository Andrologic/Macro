import { isTauriEnvironment } from '../utils/isTauriEnvironment';

export interface AppUpdateMetadata {
  currentVersion: string;
  version: string;
  date: string | null;
  notes: string;
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
  check: () => Promise<AppUpdateCheckResult>;
  download: (onEvent: (event: AppUpdateDownloadEvent) => void) => Promise<void>;
  installAndRelaunch: () => Promise<void>;
  reset: () => Promise<void>;
}

export type NativeDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export type NativeUpdate = {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  download: (onEvent?: (event: NativeDownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
  close: () => Promise<void>;
};

export interface NativeUpdaterBindings {
  getVersion: () => Promise<string>;
  check: (options?: { timeout?: number }) => Promise<NativeUpdate | null>;
  relaunch: () => Promise<void>;
}

export type LoadNativeUpdaterBindings = () => Promise<NativeUpdaterBindings>;

const CHECK_TIMEOUT_MS = 30_000;

export const isAutomaticUpdaterEnabled = (): boolean =>
  import.meta.env.PROD && isTauriEnvironment();

const closeUpdate = async (update: NativeUpdate | null): Promise<void> => {
  if (!update) return;
  try {
    await update.close();
  } catch (error) {
    console.warn('Failed to release the native updater resource:', error);
  }
};

const loadNativeUpdaterBindings: LoadNativeUpdaterBindings = async () => {
  const [{ getVersion }, { check }, { relaunch }] = await Promise.all([
    import('@tauri-apps/api/app'),
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
  ]);
  return { getVersion, check, relaunch };
};

export class TauriAppUpdaterClient implements AppUpdaterClient {
  private pendingUpdate: NativeUpdate | null = null;

  constructor(
    private readonly loadBindings: LoadNativeUpdaterBindings = loadNativeUpdaterBindings,
  ) {}

  async reset(): Promise<void> {
    const previousUpdate = this.pendingUpdate;
    this.pendingUpdate = null;
    await closeUpdate(previousUpdate);
  }

  async check(): Promise<AppUpdateCheckResult> {
    await this.reset();
    const { getVersion, check } = await this.loadBindings();
    const currentVersion = await getVersion();
    const update = await check({ timeout: CHECK_TIMEOUT_MS }) as NativeUpdate | null;
    this.pendingUpdate = update;

    return {
      currentVersion,
      update: update
        ? {
            currentVersion: update.currentVersion || currentVersion,
            version: update.version,
            date: update.date ?? null,
            notes: update.body ?? '',
          }
        : null,
    };
  }

  async download(onEvent: (event: AppUpdateDownloadEvent) => void): Promise<void> {
    const update = this.pendingUpdate;
    if (!update) {
      throw new Error('No update is available to download.');
    }

    await update.download((event) => {
      switch (event.event) {
        case 'Started':
          onEvent({
            type: 'started',
            contentLength: event.data.contentLength ?? null,
          });
          break;
        case 'Progress':
          onEvent({ type: 'progress', chunkLength: event.data.chunkLength });
          break;
        case 'Finished':
          onEvent({ type: 'finished' });
          break;
      }
    });
  }

  async installAndRelaunch(): Promise<void> {
    const update = this.pendingUpdate;
    if (!update) {
      throw new Error('No downloaded update is ready to install.');
    }

    await update.install();
    this.pendingUpdate = null;
    await closeUpdate(update);
    const { relaunch } = await this.loadBindings();
    await relaunch();
  }
}

export const appUpdaterClient: AppUpdaterClient = new TauriAppUpdaterClient();

export const toAppUpdateErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : String(error || 'Unknown update error');
