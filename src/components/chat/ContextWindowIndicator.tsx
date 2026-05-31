import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ConversationCompactionStatus,
  ConversationContextDiagnostics,
  ManualCompactionResult,
} from '../../stores/useChatStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';

interface ContextWindowIndicatorProps {
  diagnostics?: ConversationContextDiagnostics;
  compactionStatus?: ConversationCompactionStatus;
  isCompacting?: boolean;
  activityLabel?: string;
  canCompactNow?: boolean;
  manualCompactionDisabledReason?: string | null;
  manualCompactionFeedback?: ManualCompactionResult | null;
  onRefresh?: () => void;
  onCompactNow?: () => void;
}

type TranslationFunction = ReturnType<typeof useTranslation>['t'];

const formatPercent = (value?: number): string =>
  `${Math.round(Math.max(0, value ?? 0) * 100)}%`;

const formatNumber = (value?: number): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value).toLocaleString()}`
    : '0';

const formatCompactTokens = (value?: number): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (absolute >= 1000) return `${sign}${Math.round(absolute / 1000).toLocaleString()}k`;
  return Math.round(value).toLocaleString();
};

const getManualCompactionFeedbackLabel = (
  t: TranslationFunction,
  feedback?: ManualCompactionResult | null,
): string | null => {
  if (!feedback) return null;
  if (feedback.outcome === 'compacted') {
    return t('chat.contextWindow.manual.feedback.compactedLabel', 'Checkpoint created');
  }
  if (feedback.reason === 'not_enough_history') {
    return t('chat.contextWindow.manual.feedback.notEnoughHistoryLabel', 'Nothing to compact');
  }
  if (feedback.reason === 'already_current') {
    return t('chat.contextWindow.manual.feedback.alreadyCurrentLabel', 'Checkpoint up to date');
  }
  return t('chat.contextWindow.manual.feedback.skippedLabel', 'Compaction skipped');
};

const getManualCompactionFeedbackDetail = (
  t: TranslationFunction,
  feedback?: ManualCompactionResult | null,
): string | null => {
  if (!feedback) return null;
  if (feedback.outcome === 'compacted') {
    return t('chat.contextWindow.manual.feedback.compactedDetail', '{{tokens}} tokens saved', {
      tokens: formatCompactTokens(feedback.tokensSaved),
    });
  }
  switch (feedback.reason) {
    case 'not_enough_history':
      return t(
        'chat.contextWindow.manual.feedback.notEnoughHistoryDetail',
        '{{userTurns}} user turns, {{retainedTurns}} retained',
        {
          userTurns: feedback.userTurnCount,
          retainedTurns: feedback.retainedTurnCount,
        },
      );
    case 'already_current':
      return t(
        'chat.contextWindow.manual.feedback.alreadyCurrentDetail',
        'The existing checkpoint already covers the current boundary',
      );
    case 'not_beneficial':
      return t(
        'chat.contextWindow.manual.feedback.notBeneficialDetail',
        'The summary would not have reduced the payload',
      );
    case 'below_threshold':
    default:
      return t(
        'chat.contextWindow.manual.feedback.belowThresholdDetail',
        'Context is below the useful compaction threshold',
      );
  }
};

const getContextLimitLabel = (
  t: TranslationFunction,
  diagnostics?: ConversationContextDiagnostics,
): string =>
  diagnostics?.isContextLimitAuthoritative === false
    ? t('chat.contextWindow.metrics.estimatedLimit', 'Estimated limit')
    : t('chat.contextWindow.metrics.modelLimit', 'Model limit');

const getContextLimitSourceLabel = (
  t: TranslationFunction,
  diagnostics?: ConversationContextDiagnostics,
): string => {
  switch (diagnostics?.contextLimitSource) {
    case 'user_override':
      return t('chat.contextWindow.limitSource.userOverride', 'User override');
    case 'provider_metadata':
      return t('chat.contextWindow.limitSource.providerMetadata', 'Provider');
    case 'model_metadata':
      return t('chat.contextWindow.limitSource.modelMetadata', 'Model');
    case 'models_dev':
      return 'Models.dev';
    case 'provider_overflow_error':
      return t('chat.contextWindow.limitSource.providerOverflowError', 'Provider error');
    case 'macro_fallback':
      return t('chat.contextWindow.limitSource.macroFallback', 'Macro fallback');
    default:
      return t('chat.contextWindow.limitSource.unknown', 'Unknown');
  }
};

const getContextLimitConfidenceLabel = (
  t: TranslationFunction,
  diagnostics?: ConversationContextDiagnostics,
): string => {
  switch (diagnostics?.contextLimitConfidence) {
    case 'configured':
      return t('chat.contextWindow.confidence.configured', 'Configured');
    case 'verified':
      return t('chat.contextWindow.confidence.verified', 'Verified');
    case 'catalog':
      return t('chat.contextWindow.confidence.catalog', 'Catalog');
    case 'learned':
      return t('chat.contextWindow.confidence.learned', 'Learned');
    case 'fallback':
      return 'Fallback';
    default:
      return diagnostics?.isContextLimitAuthoritative === false
        ? t('chat.contextWindow.confidence.low', 'Low')
        : t('chat.contextWindow.confidence.standard', 'Standard');
  }
};

const getContextLimitWarning = (
  t: TranslationFunction,
  diagnostics?: ConversationContextDiagnostics,
): string | null => {
  if (diagnostics?.contextLimitWarning) {
    return diagnostics.contextLimitWarning;
  }
  if (diagnostics?.isContextLimitAuthoritative === false) {
    return t(
      'chat.contextWindow.warning.estimatedLimit',
      'This limit is not authoritative; Macro does not trigger automatic compaction from this value alone.',
    );
  }
  if (diagnostics?.contextLimitSource === 'provider_overflow_error') {
    return t(
      'chat.contextWindow.warning.providerOverflow',
      'This limit came from a provider error and may be replaced by fresher metadata.',
    );
  }
  return null;
};

const clampRatio = (value?: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, 0), 1)
    : 0;

const getPressureRatio = (
  diagnostics?: ConversationContextDiagnostics,
  compactionStatus?: ConversationCompactionStatus,
): number =>
  clampRatio(
    diagnostics?.usableRatio ??
      diagnostics?.ratio ??
      compactionStatus?.footprintAfter?.usableContextRatio ??
      compactionStatus?.footprintAfter?.totalContextRatio,
  );

const resolveTone = (diagnostics?: ConversationContextDiagnostics) => {
  if (!diagnostics) {
    return {
      label: 'contextWindow',
      accentClassName: 'text-muted-foreground',
    };
  }
  if (diagnostics.status === 'error' || diagnostics.phase === 'provider_error') {
    return {
      label: 'contextError',
      accentClassName: 'text-destructive',
    };
  }
  if (diagnostics.status === 'estimating') {
    return {
      label: 'contextWindow',
      accentClassName: 'text-muted-foreground',
    };
  }
  if (
    diagnostics.phase === 'blocked' ||
    diagnostics.phase === 'needs_manual_compaction'
  ) {
    return {
      label: 'compactionRequired',
      accentClassName: 'text-destructive',
    };
  }
  if (
    diagnostics.phase === 'safety_compacting' ||
    diagnostics.phase === 'model_switch_compacting' ||
    diagnostics.phase === 'recovering_overflow'
  ) {
    return {
      label: 'compacting',
      accentClassName: 'text-primary',
    };
  }
  if (diagnostics.isHardStop || diagnostics.phase === 'too_large') {
    return {
      label: 'tooLarge',
      accentClassName: 'text-destructive',
    };
  }
  const pressureRatio = getPressureRatio(diagnostics);
  if (diagnostics.phase === 'degraded' || pressureRatio >= 0.9) {
    return {
      label: diagnostics.phase === 'degraded' ? 'contextReduced' : 'nearlyFull',
      accentClassName: 'text-amber-500',
    };
  }
  if (diagnostics.phase === 'compacted') {
    return {
      label: 'contextWindow',
      accentClassName: 'text-primary',
    };
  }
  return {
    label: 'contextWindow',
    accentClassName: 'text-primary',
  };
};

const resolveToneLabel = (t: TranslationFunction, label: string): string => {
  switch (label) {
    case 'contextError':
      return t('chat.contextWindow.status.error', 'Context error');
    case 'compactionRequired':
      return t('chat.contextWindow.status.compactionRequired', 'Compaction required');
    case 'compacting':
      return t('chat.contextWindow.status.compacting', 'Compacting');
    case 'tooLarge':
      return t('chat.contextWindow.status.tooLarge', 'Context too large');
    case 'contextReduced':
      return t('chat.contextWindow.status.reduced', 'Context reduced');
    case 'nearlyFull':
      return t('chat.contextWindow.status.nearlyFull', 'Window nearly full');
    case 'contextWindow':
    default:
      return t('chat.contextWindow.status.window', 'Context window');
  }
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const diagnosticsMatchStableContext = (
  current: ConversationContextDiagnostics | undefined,
  stable: ConversationContextDiagnostics | undefined,
): boolean => {
  if (!current || !stable) return false;
  return (
    current.conversationId === stable.conversationId &&
    current.providerId === stable.providerId &&
    current.modelId === stable.modelId &&
    current.source === stable.source
  );
};

export const ContextWindowIndicator: React.FC<ContextWindowIndicatorProps> = ({
  diagnostics,
  compactionStatus,
  isCompacting = false,
  activityLabel,
  canCompactNow = true,
  manualCompactionDisabledReason,
  manualCompactionFeedback,
  onRefresh,
  onCompactNow,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [lastStableDiagnostics, setLastStableDiagnostics] = useState<
    ConversationContextDiagnostics | undefined
  >(() =>
    diagnostics?.status === 'estimating' ? undefined : diagnostics,
  );

  useEffect(() => {
    if (diagnostics && diagnostics.status !== 'estimating') {
      setLastStableDiagnostics(diagnostics);
    }
  }, [diagnostics]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        containerRef.current?.contains(target)
      ) {
        return;
      }
      setIsOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isOpen]);

  const effectiveDiagnostics =
    diagnostics?.status === 'estimating' &&
    !diagnostics.footprintAfter &&
    !diagnostics.footprintBefore &&
    diagnosticsMatchStableContext(diagnostics, lastStableDiagnostics)
      ? lastStableDiagnostics
      : diagnostics;
  const tone = resolveTone(effectiveDiagnostics);
  const toneLabel = resolveToneLabel(t, tone.label);
  const pressureRatio = getPressureRatio(effectiveDiagnostics, compactionStatus);
  const [displayedPressureRatio, setDisplayedPressureRatio] = useState(pressureRatio);
  const displayedPressureRatioRef = useRef(displayedPressureRatio);
  const svgId = useId().replace(/:/g, '');

  useEffect(() => {
    displayedPressureRatioRef.current = displayedPressureRatio;
  }, [displayedPressureRatio]);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplayedPressureRatio(pressureRatio);
      return;
    }

    const startRatio = displayedPressureRatioRef.current;
    const delta = pressureRatio - startRatio;
    if (Math.abs(delta) < 0.005) {
      setDisplayedPressureRatio(pressureRatio);
      return;
    }

    let frameId: number | null = null;
    const durationMs = 750;
    const startTime =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    const animate = (timestamp: number) => {
      const elapsed = Math.min(Math.max(timestamp - startTime, 0), durationMs);
      const progress = elapsed / durationMs;
      const easedProgress = 1 - Math.pow(1 - progress, 2);
      setDisplayedPressureRatio(startRatio + delta * easedProgress);
      if (elapsed < durationMs) {
        frameId = window.requestAnimationFrame(animate);
      }
    };

    frameId = window.requestAnimationFrame(animate);
    return () => {
      if (frameId !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [pressureRatio]);

  const totalRatio = clampRatio(
    effectiveDiagnostics?.ratio ?? compactionStatus?.footprintAfter?.totalContextRatio,
  );
  const progress = Math.round(displayedPressureRatio * 100);
  const compactionWaveLength =
    progress > 0 ? Math.max(1, Math.min(18, progress * 0.35, progress)) : 0;
  const compactionWaveStart = -Math.max(progress - compactionWaveLength, 0);
  const compactingMaskId = `context-window-compacting-mask-${svgId}`;
  const footprint =
    effectiveDiagnostics?.footprintAfter ?? effectiveDiagnostics?.footprintBefore;
  const remainingTokens = footprint
    ? footprint.usableContextTokens - footprint.totalEstimatedTokens
    : undefined;
  const savedTokens =
    effectiveDiagnostics?.footprintBefore && effectiveDiagnostics.footprintAfter
      ? effectiveDiagnostics.footprintBefore.totalEstimatedTokens -
        effectiveDiagnostics.footprintAfter.totalEstimatedTokens
      : undefined;
  const modelWindowTokens =
    effectiveDiagnostics?.modelContextWindowTokens ??
    footprint?.modelContextWindowTokens;
  const contextLimitLabel = getContextLimitLabel(t, effectiveDiagnostics);
  const contextLimitSourceLabel = getContextLimitSourceLabel(t, effectiveDiagnostics);
  const contextLimitConfidenceLabel = getContextLimitConfidenceLabel(t, effectiveDiagnostics);
  const contextLimitWarning = getContextLimitWarning(t, effectiveDiagnostics);
  const modelWindowShrank =
    Boolean(effectiveDiagnostics?.modelContextWindowShrank) ||
    Boolean(footprint?.modelContextWindowShrank);
  const checkpointLabel =
    effectiveDiagnostics?.summaryFormatVersion
      ? `v${effectiveDiagnostics.summaryFormatVersion}${
          effectiveDiagnostics.summarySource
            ? ` · ${effectiveDiagnostics.summarySource}`
            : ''
        }`
      : t('chat.contextWindow.none', 'None');
  const statusLabel = activityLabel ??
    (isCompacting ? t('chat.contextWindow.status.compacting', 'Compacting') : toneLabel);
  const compactUnavailableReason =
    isCompacting
      ? statusLabel
      : effectiveDiagnostics?.status === 'error'
        ? t('chat.contextWindow.disabled.diagnosticsError', 'Diagnostics are in error')
        : manualCompactionDisabledReason ??
          (!canCompactNow
            ? t('chat.contextWindow.disabled.unavailable', 'Action unavailable')
            : null);
  const canCompact =
    Boolean(onCompactNow) &&
    canCompactNow &&
    !isCompacting &&
    effectiveDiagnostics?.status !== 'error' &&
    !manualCompactionDisabledReason;
  const manualFeedbackLabel = getManualCompactionFeedbackLabel(t, manualCompactionFeedback);
  const manualFeedbackDetail = getManualCompactionFeedbackDetail(t, manualCompactionFeedback);
  const compactButtonLabel =
    isCompacting && activityLabel
      ? activityLabel
      : manualCompactionDisabledReason && !isCompacting
        ? t('chat.contextWindow.compactButton.none', 'Nothing to compact')
        : effectiveDiagnostics?.phase === 'too_large'
          ? t('chat.contextWindow.compactButton.aggressive', 'Compact more aggressively')
          : t('chat.contextWindow.compactButton.default', 'Compact now');

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-card/60 text-primary transition-colors hover:border-primary/40 hover:bg-primary/5',
          isOpen ? 'border-primary/50 bg-primary/10' : 'border-border/60',
        )}
        title={t(
          'chat.contextWindow.titleWithPercent',
          '{{label}} · {{percent}} of useful budget',
          {
            label: statusLabel,
            percent: formatPercent(displayedPressureRatio),
          },
        )}
        aria-label={t('chat.contextWindow.ariaLabel', 'Context diagnostics')}
        aria-expanded={isOpen}
      >
        <span className="relative flex h-5 w-5 items-center justify-center rounded-full">
          <svg
            className="absolute inset-0 h-5 w-5 -rotate-90 overflow-visible"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            {isCompacting && progress > 0 ? (
              <defs>
                <mask id={compactingMaskId} maskUnits="userSpaceOnUse">
                  <rect x="0" y="0" width="24" height="24" fill="black" />
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke="white"
                    strokeWidth="4"
                    strokeLinecap="round"
                    pathLength="100"
                    strokeDasharray={`${progress} 100`}
                    data-testid="context-window-compacting-mask-fill"
                  />
                </mask>
              </defs>
            ) : null}
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="opacity-15"
            />
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray={`${progress} 100`}
              className={cn(isCompacting && 'opacity-30')}
              data-testid="context-window-fill"
            />
            {isCompacting && progress > 0 ? (
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                pathLength="100"
                strokeDasharray={`${compactionWaveLength} 100`}
                mask={`url(#${compactingMaskId})`}
                className="context-window-compaction-wave motion-reduce:animate-none"
                style={{
                  '--context-window-wave-start': String(compactionWaveStart),
                } as React.CSSProperties}
                data-testid="context-window-compacting"
              />
            ) : null}
          </svg>
          {isCompacting ? (
            <span
              className="absolute inset-0 flex items-center justify-center"
              role="status"
              aria-label={statusLabel}
              data-testid="context-window-compacting-spinner"
            >
              <span className="flex h-3 w-3 items-center justify-center rounded-full bg-background/85">
                <span className="h-1.5 w-1.5 rounded-full bg-current/75" />
              </span>
            </span>
          ) : (
            <span className="absolute h-1.5 w-1.5 rounded-full bg-current/70" />
          )}
        </span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[320px] max-w-[calc(100vw-2rem)] rounded-lg border border-border/70 bg-popover p-3 text-popover-foreground shadow-xl">
          <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-2">
            <div className="min-w-0">
              <p className={cn('text-sm font-medium', tone.accentClassName)}>
                {statusLabel}
              </p>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {effectiveDiagnostics?.providerType ??
                  effectiveDiagnostics?.providerId ??
                  t('chat.contextWindow.providerFallback', 'Provider')} ·{' '}
                {effectiveDiagnostics?.modelId ??
                  t('chat.contextWindow.modelFallback', 'No model selected')}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold tabular-nums">
                {formatPercent(displayedPressureRatio)}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('chat.contextWindow.usefulBudgetShort', 'useful budget')}
              </p>
            </div>
          </div>

          {effectiveDiagnostics?.error ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {effectiveDiagnostics.error}
            </div>
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric
              label={t('chat.contextWindow.metrics.payload', 'Payload')}
              value={formatCompactTokens(footprint?.serializedPayloadTokens ?? footprint?.totalEstimatedTokens)}
            />
            <Metric label={contextLimitLabel} value={formatCompactTokens(modelWindowTokens)} />
            <Metric
              label={t('chat.contextWindow.metrics.usefulBudget', 'Useful budget')}
              value={formatCompactTokens(footprint?.usableContextTokens)}
            />
            <Metric
              label={t('chat.contextWindow.metrics.margin', 'Margin')}
              value={formatCompactTokens(remainingTokens)}
            />
            <Metric
              label={t('chat.contextWindow.metrics.limitSource', 'Limit source')}
              value={contextLimitSourceLabel}
            />
            <Metric
              label={t('chat.contextWindow.metrics.confidence', 'Confidence')}
              value={contextLimitConfidenceLabel}
            />
            <Metric
              label={t('chat.contextWindow.metrics.totalContext', 'Total context')}
              value={formatPercent(totalRatio)}
            />
            <Metric
              label={t('chat.contextWindow.metrics.checkpoint', 'Checkpoint')}
              value={checkpointLabel}
            />
          </div>

          {contextLimitWarning ? (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
              {contextLimitWarning}
            </div>
          ) : null}

          {modelWindowShrank ? (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
              {t(
                'chat.contextWindow.warning.modelWindowShrank',
                'The selected model has a smaller window than the last known checkpoint.',
              )}
            </div>
          ) : null}

          <section className="mt-3 space-y-2">
            {manualCompactionDisabledReason && !isCompacting ? (
              <div className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {t('chat.contextWindow.manual.action', 'Manual action')}
                  </span>
                  <span className="font-medium">
                    {t('chat.contextWindow.compactButton.none', 'Nothing to compact')}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  {manualCompactionDisabledReason}
                </p>
              </div>
            ) : null}
            {manualFeedbackLabel ? (
              <div className="rounded-md border border-border/50 bg-card/40 px-2 py-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {t('chat.contextWindow.manual.latestResult', 'Latest result')}
                  </span>
                  <span className="font-medium">{manualFeedbackLabel}</span>
                </div>
                {manualFeedbackDetail ? (
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                    {manualFeedbackDetail}
                  </p>
                ) : null}
              </div>
            ) : null}
            {effectiveDiagnostics?.footprintBefore && effectiveDiagnostics?.footprintAfter ? (
              <div className="flex items-center justify-between rounded-md border border-border/50 bg-card/40 px-2 py-1.5 text-xs">
                <span className="text-muted-foreground">
                  {t('chat.contextWindow.compaction', 'Compaction')}
                </span>
                <span className="font-medium tabular-nums">
                  {formatCompactTokens(effectiveDiagnostics.footprintBefore.totalEstimatedTokens)}
                  {' → '}
                  {formatCompactTokens(effectiveDiagnostics.footprintAfter.totalEstimatedTokens)}
                  {typeof savedTokens === 'number' && savedTokens > 0
                    ? ` (-${formatCompactTokens(savedTokens)})`
                    : ''}
                </span>
              </div>
            ) : null}
          </section>

          <p className="mt-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            {t('chat.contextWindow.countSummary', '{{messages}} messages · {{sources}} sources', {
              messages: formatNumber(effectiveDiagnostics?.counts.messages),
              sources: formatNumber(effectiveDiagnostics?.counts.citations),
            })}
          </p>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/60 px-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Icon name="refresh-cw" size={13} />
              {t('chat.contextWindow.refresh', 'Refresh')}
            </button>
            {onCompactNow ? (
              <button
                type="button"
                onClick={onCompactNow}
                disabled={!canCompact}
                title={!canCompact ? compactUnavailableReason ?? undefined : undefined}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors disabled:cursor-not-allowed',
                  canCompact
                    ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15'
                    : 'border-border/60 bg-muted/40 text-muted-foreground opacity-70',
                )}
              >
                {isCompacting ? <SpinnerIcon size={13} /> : <Icon name="archive" size={13} />}
                {compactButtonLabel}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md border border-border/50 bg-card/50 px-2 py-1.5">
    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    <p className="mt-0.5 font-medium tabular-nums">{value}</p>
  </div>
);

export default ContextWindowIndicator;
