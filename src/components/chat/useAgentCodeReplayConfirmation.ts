import { useCallback, useState } from 'react';
import type { AgentCodeReplayPreview } from '../../types';
import type { MessageImageAttachment } from '../../stores/useChatStore';
import type {
  AgentCodeReplayKind,
  PendingAgentCodeReplayConfirmation,
} from './AgentCodeReplayConfirmModal';

interface AgentCodeReplayRequest {
  kind: AgentCodeReplayKind;
  messageId: string;
  content: string;
  images?: MessageImageAttachment[];
}

interface UseAgentCodeReplayConfirmationParams {
  getAgentCodeReplayPreview: (
    messageId: string,
  ) => Promise<AgentCodeReplayPreview | null>;
  restoreAgentCodeForReplay: (preview: AgentCodeReplayPreview) => Promise<void>;
  editMessage: (
    messageId: string,
    content: string,
    options?: { skipAgentCodeReplayCheck?: boolean },
  ) => Promise<void>;
  setMessageImages: (messageId: string, images: MessageImageAttachment[]) => void;
  getMessageImages: (messageId: string) => MessageImageAttachment[];
  onEditCommitted: () => void;
}

export const useAgentCodeReplayConfirmation = ({
  getAgentCodeReplayPreview,
  restoreAgentCodeForReplay,
  editMessage,
  setMessageImages,
  getMessageImages,
  onEditCommitted,
}: UseAgentCodeReplayConfirmationParams) => {
  const [pendingReplayConfirmation, setPendingReplayConfirmation] =
    useState<PendingAgentCodeReplayConfirmation | null>(null);
  const [isReplayConfirmationSubmitting, setIsReplayConfirmationSubmitting] =
    useState(false);

  const runReplay = useCallback(
    async (
      params: AgentCodeReplayRequest & { skipAgentCodeReplayCheck?: boolean },
    ) => {
      const previousImages = params.kind === 'edit'
        ? getMessageImages(params.messageId)
        : [];
      if (params.kind === 'edit') {
        setMessageImages(params.messageId, params.images ?? []);
      }
      try {
        await editMessage(params.messageId, params.content, {
          skipAgentCodeReplayCheck: params.skipAgentCodeReplayCheck,
        });
      } catch (error) {
        if (params.kind === 'edit') {
          setMessageImages(params.messageId, previousImages);
        }
        throw error;
      }
      if (params.kind === 'edit') {
        onEditCommitted();
      }
    },
    [editMessage, getMessageImages, onEditCommitted, setMessageImages],
  );

  const requestReplay = useCallback(
    async (params: AgentCodeReplayRequest) => {
      const preview = await getAgentCodeReplayPreview(params.messageId);
      if (preview && preview.affectedFiles.length > 0) {
        setPendingReplayConfirmation({
          kind: params.kind,
          messageId: params.messageId,
          content: params.content,
          images: params.images,
          preview,
        });
        return;
      }

      await runReplay(params);
    },
    [getAgentCodeReplayPreview, runReplay],
  );

  const cancelReplayConfirmation = useCallback(() => {
    if (isReplayConfirmationSubmitting) {
      return;
    }
    setPendingReplayConfirmation(null);
  }, [isReplayConfirmationSubmitting]);

  const confirmReplayConfirmation = useCallback(async () => {
    const pending = pendingReplayConfirmation;
    if (!pending) {
      return;
    }

    setIsReplayConfirmationSubmitting(true);
    try {
      await restoreAgentCodeForReplay(pending.preview);
      await runReplay({
        ...pending,
        skipAgentCodeReplayCheck: true,
      });
      setPendingReplayConfirmation(null);
    } finally {
      setIsReplayConfirmationSubmitting(false);
    }
  }, [pendingReplayConfirmation, restoreAgentCodeForReplay, runReplay]);

  return {
    pendingReplayConfirmation,
    isReplayConfirmationSubmitting,
    requestReplay,
    cancelReplayConfirmation,
    confirmReplayConfirmation,
  };
};
