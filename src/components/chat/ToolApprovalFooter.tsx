import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingToolApproval } from '../../types';
import { getToolApprovalPresentation } from '../../services/toolApprovalPresentation';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Textarea } from '../ui/Textarea';

interface ToolApprovalFooterProps {
  pendingApproval: PendingToolApproval;
  onAllowOnce: () => void;
  onAllowForConversation: () => void;
  onDeny: (reason?: string) => void;
}

export const ToolApprovalFooter: React.FC<ToolApprovalFooterProps> = ({
  pendingApproval,
  onAllowOnce,
  onAllowForConversation,
  onDeny,
}) => {
  const { t } = useTranslation();
  const [isDenying, setIsDenying] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const approvalPresentation = getToolApprovalPresentation(
    pendingApproval,
    (key, fallback) => t(key, fallback)
  );

  const detailLabel =
    pendingApproval.toolId === 'terminal_run'
      ? t('chat.toolApprovalCommandLabel', 'Requested command')
      : pendingApproval.toolId === 'terminal_create_session' ||
          pendingApproval.toolId === 'terminal_read' ||
          pendingApproval.toolId === 'terminal_kill'
        ? t('chat.toolApprovalSessionLabel', 'Session target')
        : pendingApproval.toolId === 'web_fetch'
          ? t('chat.toolApprovalUrlLabel', 'Requested URL')
          : pendingApproval.toolId === 'web_search'
            ? t('chat.toolApprovalQueryLabel', 'Search query')
            : pendingApproval.toolId === 'read_file' ||
                pendingApproval.toolId === 'read' ||
                pendingApproval.toolId === 'write' ||
                pendingApproval.toolId === 'edit' ||
                pendingApproval.toolId === 'delete' ||
                pendingApproval.toolId === 'list' ||
                pendingApproval.toolId === 'git_add' ||
                pendingApproval.toolId === 'git_commit' ||
                pendingApproval.toolId === 'git_checkout' ||
                pendingApproval.toolId === 'git_merge' ||
                pendingApproval.toolId === 'git_reset' ||
                pendingApproval.toolId === 'git_stash'
              ? t('chat.toolApprovalPathLabel', 'Target path')
              : t('chat.toolApprovalDetailsLabel', 'Requested details');

  return (
    <div
      data-testid="tool-approval-footer"
      className="rounded-xl border border-border bg-card/85 px-3 py-2.5 shadow-sm"
    >
      <div className="space-y-2.5">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
              approvalPresentation.riskIconContainerClassName
            )}
            aria-label={approvalPresentation.riskIconLabel}
            title={approvalPresentation.riskIconLabel}
          >
            <Icon
              name={approvalPresentation.riskIcon}
              size={14}
              className={approvalPresentation.riskIconClassName}
            />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {t('chat.toolApprovalLabel', 'Tool approval')}
                </span>
                <p className="pr-1 text-sm font-medium leading-5 text-foreground text-balance">
                  {pendingApproval.summary}
                </p>
              </div>
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  approvalPresentation.categoryTone === 'danger'
                    ? 'border-destructive/25 bg-destructive/10 text-destructive'
                    : approvalPresentation.categoryTone === 'warning'
                      ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : approvalPresentation.categoryTone === 'info'
                        ? 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                        : 'border-border/60 bg-background/40 text-muted-foreground'
                )}
              >
                {approvalPresentation.categoryLabel}
              </span>
            </div>

            {pendingApproval.detail && (
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-background/55 px-2.5 py-2">
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {detailLabel}
                </span>
                <div className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] text-foreground/85 whitespace-nowrap">
                  {pendingApproval.detail}
                </div>
              </div>
            )}
          </div>
        </div>

        {isDenying ? (
          <div className="space-y-2 border-t border-border/60 pt-2.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('chat.toolApprovalReasonLabel', 'Why? (optional)')}
            </label>
            <Textarea
              data-testid="tool-approval-deny-reason"
              value={denyReason}
              onChange={(event) => setDenyReason(event.target.value)}
              rows={2}
              placeholder={t(
                'chat.toolApprovalReasonPlaceholder',
                'Add a short reason if you want Macro to know why.'
              )}
              className="min-h-[72px] border-border/70 bg-background/60"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsDenying(false);
                  setDenyReason('');
                }}
                className="h-9 rounded-lg border border-border/70 px-3"
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                variant="error"
                size="sm"
                onClick={() => onDeny(denyReason.trim() || undefined)}
                className="h-9 rounded-lg px-3"
              >
                {t('chat.toolApprovalConfirmDeny', 'Confirm denial')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onAllowOnce}
                title={t(
                  'chat.toolApprovalAllowOnceHint',
                  'Approve only this exact request.'
                )}
                className="h-9 rounded-lg px-3"
              >
                {t('chat.toolApprovalAllowOnce', 'Allow once')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={onAllowForConversation}
                title={t(
                  'chat.toolApprovalAllowConversationHint',
                  'Remember this choice for similar requests here.'
                )}
                className="h-9 rounded-lg px-3"
              >
                {t(
                  'chat.toolApprovalAllowConversation',
                  'Allow for this conversation'
                )}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setIsDenying(true)}
              title={t(
                'chat.toolApprovalDenyHint',
                'Block this request and optionally explain why.'
              )}
              className="ml-auto h-9 rounded-lg border border-border/70 px-3"
            >
              {t('chat.toolApprovalDeny', 'Refuse')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
