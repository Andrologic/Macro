import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationGoalRecord, ConversationGoalStatus } from '../../types';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';

interface ConversationGoalBannerProps {
  goal: ConversationGoalRecord;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

interface GoalStatusPresentation {
  label: string;
  description: string;
  icon: IconName;
  iconClassName: string;
  animateIcon?: boolean;
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
        icon: 'loader',
        iconClassName: 'text-blue-400',
        animateIcon: true,
      };
    case 'audit_pending':
      return {
        label: t('goal.status.auditPending', 'Review pending'),
        description: t('goal.status.auditPendingDescription', 'The last agent turn still needs an independent goal review.'),
        icon: 'clock',
        iconClassName: 'text-amber-400',
      };
    case 'auditing':
      return {
        label: t('goal.status.auditing', 'Goal review in progress'),
        description: t('goal.status.auditingDescription', 'A separate read-only agent is reviewing the evidence.'),
        icon: 'shield',
        iconClassName: 'text-violet-400',
      };
    case 'continuation_pending':
      return {
        label: t('goal.status.continuationPending', 'Continuation pending'),
        description: t('goal.status.continuationPendingDescription', 'The review found more work for the agent.'),
        icon: 'rotate-ccw',
        iconClassName: 'text-blue-400',
      };
    case 'awaiting_user':
      return {
        label: t('goal.status.awaitingUser', 'Your response is needed'),
        description: t('goal.status.awaitingUserDescription', 'Answer in the composer so the goal can continue.'),
        icon: 'message-circle-question',
        iconClassName: 'text-amber-400',
      };
    case 'paused':
      return {
        label: t('goal.status.paused', 'Goal paused'),
        description: t('goal.status.pausedDescription', 'Macro will not continue this goal until you resume it.'),
        icon: 'pause',
        iconClassName: 'text-muted-foreground',
      };
    case 'achieved':
      return {
        label: t('goal.status.achieved', 'Goal achieved'),
        description: t('goal.status.achievedDescription', 'An independent reviewer verified the objective.'),
        icon: 'check',
        iconClassName: 'text-emerald-400',
      };
    case 'error':
      return {
        label: t('goal.status.error', 'Goal interrupted'),
        description: t('goal.status.errorDescription', 'The goal stopped because Macro encountered an error.'),
        icon: 'triangle-alert',
        iconClassName: 'text-destructive',
      };
    case 'active_ready':
    default:
      return {
        label: t('goal.status.active', 'Goal active'),
        description: t('goal.status.activeDescription', 'The objective is ready for the next agent turn.'),
        icon: 'target',
        iconClassName: 'text-primary',
      };
  }
};

export const ConversationGoalBanner: React.FC<ConversationGoalBannerProps> = ({
  goal,
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
      aria-label={t('goal.bannerLabel', 'Conversation goal')}
      className="border-b border-primary/15 bg-primary/[0.035] px-4 py-2.5"
    >
      <div className="mx-auto flex max-w-5xl items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
          <Icon
            name={presentation.icon}
            size={15}
            className={cn(
              presentation.iconClassName,
              presentation.animateIcon && 'animate-spin motion-reduce:animate-none',
            )}
          />
        </span>

        <div className="min-w-0 flex-1">
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
              {t('goal.modeLabel', 'Goal mode')}
            </span>
            <span className="h-1 w-1 rounded-full bg-border" aria-hidden="true" />
            <span className="text-xs font-medium text-foreground">{presentation.label}</span>
          </div>
          <p className="mt-0.5 break-words text-sm leading-snug text-foreground">
            {goal.objective}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{presentation.description}</p>

          {hasAuditDetails && goal.latestVerdict && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium text-foreground/80">
                {t('goal.lastReview', 'Last review')}
              </summary>
              <div className="mt-1.5 rounded-md border border-border/70 bg-background/50 px-2.5 py-2">
                <p>{goal.latestVerdict.summary}</p>
                {goal.latestVerdict.criteria.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {goal.latestVerdict.criteria.map((criterion, index) => (
                      <li key={`${criterion.criterion}-${index}`} className="flex gap-1.5">
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
                        <span>{criterion.criterion}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {canPause && (
            <button
              type="button"
              onClick={onPause}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t('goal.pauseHint', 'Pause automatic continuation')}
            >
              <Icon name="pause" size={12} />
              {t('goal.pause', 'Pause')}
            </button>
          )}
          {canResume && (
            <button
              type="button"
              onClick={onResume}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t('goal.resumeHint', 'Resume goal tracking')}
            >
              <Icon name="play" size={12} />
              {t('goal.resume', 'Resume tracking')}
            </button>
          )}
          {goal.status !== 'achieved' && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title={t('goal.stopHint', 'Leave Goal mode for this conversation')}
            >
              <Icon name="x" size={12} />
              {t('goal.stop', 'Stop')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
};
