import { invoke, isBrowserRuntimeBridgeEnabled } from '../tauriRuntimeBridge';
import type {
  ArchiveOpenInput, ArchiveReadHandle, ArchivePageInput, ArchivePage,
  ArchiveMaterializeInput, ArchiveBacking, ArchiveReleaseInput,
} from '../../types/generated/ipc';

export type {
  ArchiveSelector, ArchiveOpenInput, ArchiveReadHandle, ArchivePageInput,
  ArchivePage, ArchiveItem, ArchiveResource, ArchiveMaterializeInput,
  ArchiveBacking, ArchiveRange, ArchiveUse,
} from '../../types/generated/ipc';

function native<T>(command: string, input: unknown): Promise<T> {
  if (typeof window === 'undefined' || isBrowserRuntimeBridgeEnabled() ||
      typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke !== 'function') {
    return Promise.reject(new Error('Native desktop archive storage is unavailable.'));
  }
  return invoke<T>(command, { input });
}

export const connectArchiveOpen = (input: ArchiveOpenInput): Promise<ArchiveReadHandle> => native('connect_archive_open', input);
export const connectArchivePage = (input: ArchivePageInput): Promise<ArchivePage> => native('connect_archive_page', input);
export const connectArchiveMaterialize = (input: ArchiveMaterializeInput): Promise<ArchiveBacking> => native('connect_archive_materialize', input);
export const connectArchiveRelease = (input: ArchiveReleaseInput): Promise<void> => native('connect_archive_release', input);
