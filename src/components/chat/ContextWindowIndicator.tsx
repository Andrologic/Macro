import React, { useEffect, useRef, useState } from 'react';

import type { ConversationContextDiagnostics } from '../../stores/useChatStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';

interface ContextWindowIndicatorProps {
  diagnostics?: ConversationContextDiagnostics;
  isCompacting?: boolean;
  canCompactNow?: boolean;
  onRefresh?: () => void;
  onCompactNow?: () => void;
}

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

const getPressureRatio = (diagnostics?: ConversationContextDiagnostics): number =>
  Math.min(
    Math.max(diagnostics?.usableRatio ?? diagnostics?.ratio ?? 0, 0),
    1,
  );

const resolveTone = (diagnostics?: ConversationContextDiagnostics) => {
  if (!diagnostics) {
    return {
      label: 'Contexte non mesuré',
      accentClassName: 'text-muted-foreground',
    };
  }
  if (diagnostics.status === 'error' || diagnostics.phase === 'provider_error') {
    return {
      label: 'Erreur contexte',
      accentClassName: 'text-destructive',
    };
  }
  if (diagnostics.isHardStop || diagnostics.phase === 'too_large') {
    return {
      label: 'Contexte trop volumineux',
      accentClassName: 'text-destructive',
    };
  }
  const pressureRatio = getPressureRatio(diagnostics);
  if (diagnostics.phase === 'degraded' || pressureRatio >= 0.9) {
    return {
      label: 'Contexte élevé',
      accentClassName: 'text-amber-500',
    };
  }
  if (diagnostics.phase === 'compacted') {
    return {
      label: 'Contexte compacté',
      accentClassName: 'text-primary',
    };
  }
  return {
    label: 'Contexte disponible',
    accentClassName: 'text-primary',
  };
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const ContextWindowIndicator: React.FC<ContextWindowIndicatorProps> = ({
  diagnostics,
  isCompacting = false,
  canCompactNow = true,
  onRefresh,
  onCompactNow,
}) => {
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
    !diagnostics.footprintBefore
      ? lastStableDiagnostics
      : diagnostics;
  const tone = resolveTone(effectiveDiagnostics);
  const pressureRatio = getPressureRatio(effectiveDiagnostics);
  const [displayedPressureRatio, setDisplayedPressureRatio] = useState(pressureRatio);
  const displayedPressureRatioRef = useRef(displayedPressureRatio);

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

  const totalRatio = Math.min(Math.max(effectiveDiagnostics?.ratio ?? 0, 0), 1);
  const progress = Math.round(displayedPressureRatio * 100);
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
  const canCompact =
    Boolean(onCompactNow) &&
    canCompactNow &&
    !isCompacting &&
    effectiveDiagnostics?.status !== 'error';
  const statusLabel = isCompacting ? 'Compaction en cours' : tone.label;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-card/60 text-primary transition-colors hover:border-primary/40 hover:bg-primary/5',
          isOpen ? 'border-primary/50 bg-primary/10' : 'border-border/60',
        )}
        title={`${statusLabel} · ${formatPercent(displayedPressureRatio)} du budget utile`}
        aria-label="Diagnostic du contexte"
        aria-expanded={isOpen}
      >
        <span className="relative flex h-5 w-5 items-center justify-center rounded-full">
          <svg
            className={cn(
              'absolute inset-0 h-5 w-5 -rotate-90 overflow-visible',
              isCompacting && 'animate-spin',
            )}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="opacity-15"
            />
            {isCompacting ? (
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                pathLength="100"
                strokeDasharray="18 100"
                className="opacity-40"
                data-testid="context-window-compacting"
              />
            ) : null}
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
              data-testid="context-window-fill"
            />
          </svg>
          {isCompacting ? (
            <span
              className="relative flex h-4 w-4 items-center justify-center rounded-full bg-background/85"
              data-testid="context-window-compacting-spinner"
            >
              <SpinnerIcon size={12} className="text-primary" label="Compaction en cours" />
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
                  'Provider'} ·{' '}
                {effectiveDiagnostics?.modelId ?? 'Modèle non sélectionné'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold tabular-nums">
                {formatPercent(displayedPressureRatio)}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                budget utile
              </p>
            </div>
          </div>

          {effectiveDiagnostics?.error ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {effectiveDiagnostics.error}
            </div>
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="Payload" value={formatCompactTokens(footprint?.serializedPayloadTokens ?? footprint?.totalEstimatedTokens)} />
            <Metric label="Budget utile" value={formatCompactTokens(footprint?.usableContextTokens)} />
            <Metric label="Marge" value={formatCompactTokens(remainingTokens)} />
            <Metric label="Contexte total" value={formatPercent(totalRatio)} />
          </div>

          <section className="mt-3 space-y-2">
            {effectiveDiagnostics?.footprintBefore && effectiveDiagnostics?.footprintAfter ? (
              <div className="flex items-center justify-between rounded-md border border-border/50 bg-card/40 px-2 py-1.5 text-xs">
                <span className="text-muted-foreground">Compaction</span>
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
            {formatNumber(effectiveDiagnostics?.counts.messages)} messages ·{' '}
            {formatNumber(effectiveDiagnostics?.counts.citations)} sources
          </p>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/60 px-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Icon name="refresh-cw" size={13} />
              Actualiser
            </button>
            {onCompactNow ? (
              <button
                type="button"
                onClick={onCompactNow}
                disabled={!canCompact}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 text-xs text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCompacting ? <SpinnerIcon size={13} /> : <Icon name="archive" size={13} />}
                {effectiveDiagnostics?.phase === 'too_large'
                  ? 'Compacter plus agressivement'
                  : 'Compacter maintenant'}
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
