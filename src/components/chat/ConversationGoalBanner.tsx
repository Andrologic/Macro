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
      data-goal-status={goal.status}
      aria-label={t('goal.bannerLabel', 'Conversation goal')}
      className="border-b border-primary/10 bg-primary/[0.018] px-4 py-3"
    >
      <div className="relative mx-auto max-w-5xl overflow-hidden rounded-xl border border-primary/20 bg-card/75 shadow-[0_12px_34px_-28px_rgb(var(--primary)/0.75),inset_0_1px_0_rgba(255,255,255,0.035)] backdrop-blur-sm">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/55 to-transparent"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-12 -top-16 h-36 w-48 rounded-full bg-primary/[0.075] blur-3xl"
        />

        <div className="relative flex items-start gap-3 p-3">
          <span className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 shadow-[inset_0_1px_0_rgb(var(--primary)/0.16),0_0_18px_rgb(var(--primary)/0.08)]">
            <Icon
              name={presentation.icon}
              size={16}
              className={cn(
                presentation.iconClassName,
                presentation.animateIcon && 'animate-spin motion-reduce:animate-none',
              )}
            />
            <span
              aria-hidden="true"
              className={cn(
                'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-card',
                goal.status === 'achieved'
                  ? 'bg-emerald-400'
                  : goal.status === 'error'
                    ? 'bg-destructive'
                    : goal.status === 'paused'
                      ? 'bg-muted-foreground'
                      : 'bg-primary',
              )}
            />
          </span>

          <div className="min-w-0 flex-1">
            <div
              className="flex flex-wrap items-center gap-1.5"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="inline-flex h-5 items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-primary">
                <Icon name="target" size={9} />
                {t('goal.modeLabel', 'Goal mode')}
              </span>
              <span className="inline-flex h-5 items-center rounded-md border border-border/60 bg-background/45 px-1.5 text-[10px] font-medium text-foreground/85">
                {presentation.label}
              </span>
            </div>
            <p className="mt-1.5 break-words text-[13px] font-medium leading-snug text-foreground">
              {goal.objective}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {presentation.description}
            </p>

            {hasAuditDetails && goal.latestVerdict && (
              <details className="group mt-2.5 text-xs text-muted-foreground">
                <summary className="flex w-fit cursor-pointer list-none select-none items-center gap-1.5 rounded-md border border-border/60 bg-background/35 px-2 py-1 font-medium text-foreground/80 transition-colors hover:border-primary/25 hover:bg-primary/[0.045] [&::-webkit-details-marker]:hidden">
                  <Icon
                    name="chevron-right"
                    size={11}
                    className="transition-transform group-open:rotate-90 motion-reduce:transition-none"
                  />
                  {t('goal.lastReview', 'Last review')}
                </summary>
                <div className="mt-2 rounded-lg border border-border/60 bg-background/45 px-2.5 py-2.5 shadow-inner">
                  <p className="leading-relaxed text-foreground/80">{goal.latestVerdict.summary}</p>
                  {goal.latestVerdict.criteria.length > 0 && (
                    <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                      {goal.latestVerdict.criteria.map((criterion, index) => (
                        <li
                          key={`${criterion.criterion}-${index}`}
                          className="flex min-w-0 gap-2 rounded-md border border-border/45 bg-card/45 px-2 py-1.5"
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'mt-1 h-1.5 w-1.5 shrink-0 rounded-full ring-2 ring-background',
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
          </div>

          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border/55 bg-background/35 p-0.5">
            {canPause && (
              <button
                type="button"
                onClick={onPause}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t('goal.pauseHint', 'Pause automatic continuation')}
              >
                <Icon name="pause" size={11} />
                {t('goal.pause', 'Pause')}
              </button>
            )}
            {canResume && (
              <button
                type="button"
                onClick={onResume}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                title={t('goal.resumeHint', 'Resume goal tracking')}
              >
                <Icon name="play" size={11} />
                {t('goal.resume', 'Resume tracking')}
              </button>
            )}
            {goal.status !== 'achieved' && (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                title={t('goal.stopHint', 'Leave Goal mode for this conversation')}
              >
                <Icon name="x" size={11} />
                {t('goal.stop', 'Stop')}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
