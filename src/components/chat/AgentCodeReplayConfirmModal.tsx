import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentCodeReplayPreview } from '../../types';
import type { MessageImageAttachment } from '../../stores/useChatStore';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';

export type AgentCodeReplayKind = 'edit' | 'regenerate';

export interface PendingAgentCodeReplayConfirmation {
  kind: AgentCodeReplayKind;
  messageId: string;
  content: string;
  images?: MessageImageAttachment[];
  preview: AgentCodeReplayPreview;
}

interface AgentCodeReplayConfirmModalProps {
  pendingReplayConfirmation: PendingAgentCodeReplayConfirmation | null;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const AgentCodeReplayConfirmModal: React.FC<
  AgentCodeReplayConfirmModalProps
> = ({
  pendingReplayConfirmation,
  isSubmitting,
  onCancel,
  onConfirm,
}) => {
  const { t } = useTranslation();

  return (
    <ConfirmPromptModal
      isOpen={Boolean(pendingReplayConfirmation)}
      title={t('chat.agentCodeReplayTitle', 'Revenir au point de contrôle du code ?')}
      description={t(
        'chat.agentCodeReplayDescription',
        'Les modifications faites par Macro après ce message seront effacées avant la relance. Les fichiers changés depuis le dernier checkpoint sont signalés ci-dessous.'
      )}
      confirmLabel={
        pendingReplayConfirmation?.kind === 'edit'
          ? t('chat.agentCodeReplayConfirmEdit', 'Restaurer et sauvegarder')
          : t('chat.agentCodeReplayConfirmRegenerate', 'Restaurer et relancer')
      }
      cancelLabel={t('common.cancel', 'Annuler')}
      confirmVariant="error"
      isSubmitting={isSubmitting}
      onCancel={onCancel}
      onConfirm={() => {
        onConfirm();
      }}
    >
      {pendingReplayConfirmation && (
        <div className="space-y-3">
          {pendingReplayConfirmation.preview.hasExternalChanges && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {t(
                'chat.agentCodeReplayExternalChangesDetected',
                'Certains fichiers ont changé depuis le dernier point enregistré. Confirmer restaurera uniquement les fichiers listés.'
              )}
            </div>
          )}
          <div className="max-h-52 overflow-y-auto rounded-lg border border-border bg-background/60">
            {pendingReplayConfirmation.preview.affectedFiles.map((file) => {
              const statusLabel =
                file.status === 'created'
                  ? t('chat.agentCodeReplayFileCreated', 'créé')
                  : file.status === 'deleted'
                    ? t('chat.agentCodeReplayFileDeleted', 'supprimé')
                    : t('chat.agentCodeReplayFileModified', 'modifié');
              return (
                <div
                  key={file.realPath}
                  className="flex items-start gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
                >
                  <span className="mt-0.5 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {statusLabel}
                  </span>
                  {file.hasExternalChanges && (
                    <span className="mt-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                      {t('chat.agentCodeReplayExternalFileChanged', 'changé')}
                    </span>
                  )}
                  <span className="min-w-0 break-all text-xs text-foreground">
                    {file.path}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              'chat.agentCodeReplayExternalWarning',
              'Seuls les fichiers suivis par les outils d’édition de Macro sont restaurés, y compris les fichiers non suivis créés par l’agent.'
            )}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              'chat.agentCodeReplayCompactionWarning',
              'Les compactages de contexte après ce message seront recalculés.'
            )}
          </p>
        </div>
      )}
    </ConfirmPromptModal>
  );
};
