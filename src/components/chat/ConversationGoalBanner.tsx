import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationGoalRecord, ConversationGoalStatus } from '../../types';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

interface ConversationGoalBannerProps {
  goal: ConversationGoalRecord;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

interface GoalStatusPresentation {
  label: string;
  description: string;
}

const useGoalStatusPresentation = (
  status: ConversationGoalStatus,
): GoalStatusPresentation => {
  const { t } = useTranslation();

  switch (status) {
    case 'executor_running':
      return {
        label: t('goal.status.executorRunning', 'Agent working'),
        description: t('goal.status.executorRunningDescription', 'The executor is working toward the objective.'),
      };
    case 'audit_pending':
      return {
        label: t('goal.status.auditPending', 'Review pending'),
        description: t('goal.status.auditPendingDescription', 'The last agent turn still needs an independent goal review.'),
      };
    case 'auditing':
      return {
        label: t('goal.status.auditing', 'Goal review in progress'),
        description: t('goal.status.auditingDescription', 'A separate read-only agent is reviewing the evidence.'),
      };
    case 'continuation_pending':
      return {
        label: t('goal.status.continuationPending', 'Continuation pending'),
        description: t('goal.status.continuationPendingDescription', 'The review found more work for the agent.'),
      };
    case 'awaiting_user':
      return {
        label: t('goal.status.awaitingUser', 'Your response is needed'),
        description: t('goal.status.awaitingUserDescription', 'Answer in the composer so the goal can continue.'),
      };
    case 'paused':
      return {
        label: t('goal.status.paused', 'Goal paused'),
        description: t('goal.status.pausedDescription', 'Macro will not continue this goal until you resume it.'),
      };
    case 'achieved':
      return {
        label: t('goal.status.achieved', 'Goal achieved'),
        description: t('goal.status.achievedDescription', 'An independent reviewer verified the objective.'),
      };
    case 'error':
      return {
        label: t('goal.status.error', 'Goal interrupted'),
        description: t('goal.status.errorDescription', 'The goal stopped because Macro encountered an error.'),
      };
    case 'active_ready':
    default:
      return {
        label: t('goal.status.active', 'Goal active'),
        description: t('goal.status.activeDescription', 'The objective is ready for the next agent turn.'),
      };
  }
};

export const ConversationGoalBanner: React.FC<ConversationGoalBannerProps> = ({
  goal,
  onEdit,
  onPause,
  onResume,
  onStop,
}) => {
  const { t } = useTranslation();
  const presentation = useGoalStatusPresentation(goal.status);
  const canResume = goal.status === 'paused' || goal.status === 'error';
  const canPause = goal.status !== 'paused' && goal.status !== 'achieved' && goal.status !== 'error';
  const hasAuditDetails = Boolean(goal.latestVerdict);

  return (
    <section
      data-conversation-goal-banner
      data-goal-compact-bar="true"
      data-goal-status={goal.status}
      aria-label={t('goal.bannerLabel', 'Conversation goal')}
      className="relative z-20 border-b border-border/50 bg-background/35"
    >
      <div className="flex h-9 min-w-0 items-center gap-2 px-4">
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold text-primary">
          <Icon name="target" size={11} />
          <span>{t('goal.shortLabel', 'Goal')}</span>
        </span>

        <span className="h-4 w-px shrink-0 bg-border/70" aria-hidden="true" />

        <p
          className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90"
          title={goal.objective}
        >
          {goal.objective}
        </p>

        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {presentation.label}. {presentation.description}
        </span>

        <div className="flex shrink-0 items-center border-l border-border/60 pl-1">
          {hasAuditDetails && goal.latestVerdict && (
            <details className="group relative shrink-0 text-xs text-muted-foreground">
              <summary
                className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 [&::-webkit-details-marker]:hidden"
                title={t('goal.lastReview', 'Last review')}
                aria-label={t('goal.lastReview', 'Last review')}
              >
                <Icon name="shield" size={12} />
              </summary>
              <div className="absolute right-0 top-9 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border/70 bg-card/95 p-3 text-xs shadow-2xl backdrop-blur">
                <div className="mb-2 flex items-center gap-2 text-foreground">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon name="shield" size={12} />
                  </span>
                  <span className="font-medium">{t('goal.lastReview', 'Last review')}</span>
                </div>
                <p className="leading-relaxed text-foreground/80">{goal.latestVerdict.summary}</p>
                {goal.latestVerdict.criteria.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {goal.latestVerdict.criteria.map((criterion, index) => (
                      <li
                        key={`${criterion.criterion}-${index}`}
                        className="flex gap-2 rounded-md border border-border/45 bg-background/35 px-2 py-1.5"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                            criterion.status === 'met'
                              ? 'bg-emerald-400'
                              : criterion.status === 'unmet'
                                ? 'bg-destructive'
                                : 'bg-amber-400',
                          )}
                        />
                        <span className="sr-only">
                          {criterion.status === 'met'
                            ? t('goal.criterionStatus.met', 'Met')
                            : criterion.status === 'unmet'
                              ? t('goal.criterionStatus.unmet', 'Not met')
                              : t('goal.criterionStatus.uncertain', 'Uncertain')}
                          {': '}
                        </span>
                        <span className="min-w-0 leading-snug">{criterion.criterion}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          )}
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
            title={t('goal.editHint', 'Edit the current goal in the composer')}
            aria-label={t('goal.edit', 'Edit goal')}
          >
            <Icon name="edit" size={12} />
          </button>
          {canPause && (
            <button
              type="button"
              onClick={onPause}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              title={t('goal.pauseHint', 'Pause automatic continuation')}
              aria-label={t('goal.pause', 'Pause')}
            >
              <Icon name="pause" size={12} />
            </button>
          )}
          {canResume && (
            <button
              type="button"
              onClick={onResume}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              title={t('goal.resumeHint', 'Resume goal tracking')}
              aria-label={t('goal.resume', 'Resume tracking')}
            >
              <Icon name="play" size={12} />
            </button>
          )}
          {goal.status !== 'achieved' && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50"
              title={t('goal.stopHint', 'Leave Goal mode for this conversation')}
              aria-label={t('goal.stop', 'Stop')}
            >
              <Icon name="square" size={10} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
};
