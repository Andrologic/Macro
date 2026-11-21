import { invoke, isBrowserRuntimeBridgeEnabled } from '../tauriRuntimeBridge';
import type {
  PilotInspectAttachmentsInput, PilotAttachmentMetadata, PilotFileAuthorizeInput, PilotFileBeginInput, PilotFileChunkInput, PilotFileTransferInput,
  PilotFileImage, PilotFileGuard, PilotFileReceipt, PilotPrepareSendInput, PilotPreparedSend,
  PilotSendReadInput, PilotSendMarkInput, PilotSendReceipt, PilotFileSource,
  PilotFileReadInput, PilotFileRead,
} from '../../types/generated/ipc';
export type {
  PilotInspectAttachmentsInput, PilotAttachmentMetadata, PilotFileSourceKind, PilotCitationScope, PilotFileContentState, PilotFileContextState, PilotConversationKind, PilotFileRef, PilotFileScope, PilotFileAuthorizeInput,
  PilotFileBeginInput, PilotFileChunkInput, PilotFileTransferInput, PilotFileGuard,
  PilotFileReceipt, PilotFileState, PilotPrepareSendInput, PilotPreparedSend,
  PilotFileContextRef, PilotFileImage, PilotSendReadInput, PilotSendMarkInput,
  PilotSendReceipt, PilotSendState, PilotFileSource, PilotFileReadInput, PilotFileRead,
} from '../../types/generated/ipc';

function native<T>(command: string, input: unknown): Promise<T> {
  if (typeof window === 'undefined' || isBrowserRuntimeBridgeEnabled() ||
      typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke !== 'function') {
    return Promise.reject(new Error('Native desktop file storage is unavailable.'));
  }
  return invoke<T>(command, { input });
}
export const pilotFilesAuthorize = (input: PilotFileAuthorizeInput): Promise<void> => native("pilot_files_authorize", input);
export const pilotFilesBegin = (input: PilotFileBeginInput): Promise<PilotFileReceipt> => native("pilot_files_begin", input);
export const pilotFilesChunk = (input: PilotFileChunkInput): Promise<PilotFileReceipt> => native("pilot_files_chunk", input);
export const pilotFilesStatus = (input: PilotFileTransferInput): Promise<PilotFileReceipt> => native("pilot_files_status", input);
export const pilotFilesFinalize = (input: PilotFileTransferInput): Promise<PilotFileReceipt> => native("pilot_files_finalize", input);
export const pilotFilesAbort = (input: PilotFileTransferInput): Promise<PilotFileReceipt> => native("pilot_files_abort", input);
export const pilotFilesPrepareSend = (input: PilotPrepareSendInput): Promise<PilotPreparedSend> => native("pilot_files_prepare_send", input);
export const pilotFilesSendRead = (input: PilotSendReadInput): Promise<PilotSendReceipt> => native("pilot_files_send_read", input);
export const pilotFilesSendMark = (input: PilotSendMarkInput): Promise<PilotSendReceipt> => native("pilot_files_send_mark", input);
export const pilotFilesList = (input: PilotFileGuard): Promise<PilotFileSource[]> => native("pilot_files_list", input);
export const pilotFilesRead = (input: PilotFileReadInput): Promise<PilotFileRead> => native("pilot_files_read", input);

export const pilotFilesInspectAttachments = (input: PilotInspectAttachmentsInput): Promise<PilotAttachmentMetadata[]> => native("pilot_files_inspect_attachments", input);

export function dbPilotMessageImages(messageId: string): Promise<PilotFileImage[]> {
  if (typeof window === 'undefined' || isBrowserRuntimeBridgeEnabled() ||
      typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke !== 'function') {
    return Promise.reject(new Error('Native desktop file storage is unavailable.'));
  }
  return invoke('db_pilot_message_images', { messageId });
}
