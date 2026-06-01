import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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

const POPOVER_EDGE_OFFSET = 8;

const formatPercent = (value?: number): string =>
  `${Math.round(Math.max(0, value ?? 0) * 100)}%`;

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
  onRefresh,
  onCompactNow,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);
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

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePopoverPosition = () => {
      const container = containerRef.current;
      const conversationPanel = container?.closest<HTMLElement>(
        '[data-chat-conversation-panel]',
      );
      const conversationHeader = container?.closest<HTMLElement>(
        '[data-chat-conversation-header]',
      );

      if (!conversationPanel || !conversationHeader) {
        setPopoverPosition(null);
        return;
      }

      const panelRect = conversationPanel.getBoundingClientRect();
      const headerRect = conversationHeader.getBoundingClientRect();

      setPopoverPosition({
        top: Math.round(headerRect.bottom + POPOVER_EDGE_OFFSET),
        right: Math.max(
          POPOVER_EDGE_OFFSET,
          Math.round(window.innerWidth - panelRect.right + POPOVER_EDGE_OFFSET),
        ),
      });
    };

    updatePopoverPosition();
    window.addEventListener('resize', updatePopoverPosition);
    return () => {
      window.removeEventListener('resize', updatePopoverPosition);
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

  const progress = Math.round(displayedPressureRatio * 100);
  const compactionWaveLength =
    progress > 0 ? Math.max(1, Math.min(18, progress * 0.35, progress)) : 0;
  const compactionWaveStart = -Math.max(progress - compactionWaveLength, 0);
  const compactingMaskId = `context-window-compacting-mask-${svgId}`;
  const footprint =
    effectiveDiagnostics?.footprintAfter ?? effectiveDiagnostics?.footprintBefore;
  const progressWidth = Math.min(Math.max(displayedPressureRatio * 100, 0), 100);
  const progressClassName =
    tone.accentClassName === 'text-destructive'
      ? 'bg-destructive'
      : tone.accentClassName === 'text-amber-500'
        ? 'bg-amber-500'
        : 'bg-primary';
  const contextLimitWarning = getContextLimitWarning(t, effectiveDiagnostics);
  const modelWindowShrank =
    Boolean(effectiveDiagnostics?.modelContextWindowShrank) ||
    Boolean(footprint?.modelContextWindowShrank);
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
        <div
          className={cn(
            'z-50 w-[280px] max-w-[calc(100vw-2rem)] rounded-lg border border-border/70 bg-popover p-3 text-popover-foreground shadow-xl',
            popoverPosition ? 'fixed' : 'absolute right-0 top-full mt-2',
          )}
          style={
            popoverPosition
              ? {
                  top: popoverPosition.top,
                  right: popoverPosition.right,
                }
              : undefined
          }
        >
          <div className="flex items-start justify-between gap-3">
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
            </div>
          </div>

          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-[width] duration-500', progressClassName)}
              style={{ width: `${progressWidth}%` }}
            />
          </div>

          {effectiveDiagnostics?.error ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {effectiveDiagnostics.error}
            </div>
          ) : null}

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

export default ContextWindowIndicator;
