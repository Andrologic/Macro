import React, { useState } from 'react';

import type { ConversationContextDiagnostics } from '../../stores/useChatStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';

interface ContextWindowIndicatorProps {
  diagnostics?: ConversationContextDiagnostics;
  isBusy?: boolean;
  isCompacting?: boolean;
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
      label: 'Contexte inconnu',
      className: 'text-muted-foreground',
    };
  }
  if (diagnostics.status === 'error' || diagnostics.phase === 'provider_error') {
    return {
      label: 'Erreur contexte',
      className: 'text-destructive',
    };
  }
  if (diagnostics.isHardStop || diagnostics.phase === 'too_large') {
    return {
      label: 'Contexte trop volumineux',
      className: 'text-destructive',
    };
  }
  const pressureRatio = getPressureRatio(diagnostics);
  if (diagnostics.phase === 'degraded' || pressureRatio >= 0.9) {
    return {
      label: 'Contexte dégradé',
      className: 'text-amber-500',
    };
  }
  if (diagnostics.phase === 'compacted' || pressureRatio >= 0.72) {
    return {
      label: 'Contexte compacté',
      className: 'text-primary',
    };
  }
  return {
    label: 'Contexte disponible',
    className: 'text-emerald-500',
  };
};

export const ContextWindowIndicator: React.FC<ContextWindowIndicatorProps> = ({
  diagnostics,
  isBusy = false,
  isCompacting = false,
  onRefresh,
  onCompactNow,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const tone = resolveTone(diagnostics);
  const pressureRatio = getPressureRatio(diagnostics);
  const totalRatio = Math.min(Math.max(diagnostics?.ratio ?? 0, 0), 1);
  const progress = Math.round(pressureRatio * 100);
  const footprint = diagnostics?.footprintAfter ?? diagnostics?.footprintBefore;
  const remainingTokens = footprint
    ? footprint.usableContextTokens - footprint.totalEstimatedTokens
    : undefined;
  const savedTokens =
    diagnostics?.footprintBefore && diagnostics.footprintAfter
      ? diagnostics.footprintBefore.totalEstimatedTokens -
        diagnostics.footprintAfter.totalEstimatedTokens
      : undefined;
  const canCompact =
    Boolean(onCompactNow) &&
    !isCompacting &&
    diagnostics?.status !== 'estimating' &&
    getPressureRatio(diagnostics) >= 0.6;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card/60 transition-colors hover:border-primary/40 hover:text-primary',
          tone.className,
        )}
        title={`${tone.label} · ${formatPercent(pressureRatio)} du budget utile`}
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
              className="transition-[stroke-dasharray] duration-300 ease-out"
              data-testid="context-window-fill"
            />
          </svg>
          <span className="absolute h-1.5 w-1.5 rounded-full bg-current/70" />
          {isBusy ? (
            <SpinnerIcon size={11} className="relative text-current" />
          ) : null}
        </span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[320px] max-w-[calc(100vw-2rem)] rounded-lg border border-border/70 bg-popover p-3 text-popover-foreground shadow-xl">
          <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full bg-current', tone.className)} />
                <p className="text-sm font-medium">{tone.label}</p>
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {diagnostics?.providerType ?? diagnostics?.providerId ?? 'Provider'} ·{' '}
                {diagnostics?.modelId ?? 'Modèle non sélectionné'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold tabular-nums">{formatPercent(pressureRatio)}</p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                budget utile
              </p>
            </div>
          </div>

          {diagnostics?.error ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {diagnostics.error}
            </div>
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="Payload" value={formatCompactTokens(footprint?.serializedPayloadTokens ?? footprint?.totalEstimatedTokens)} />
            <Metric label="Budget utile" value={formatCompactTokens(footprint?.usableContextTokens)} />
            <Metric label="Marge" value={formatCompactTokens(remainingTokens)} />
            <Metric label="Contexte total" value={formatPercent(totalRatio)} />
          </div>

          <section className="mt-3 space-y-2">
            {diagnostics?.footprintBefore && diagnostics?.footprintAfter ? (
              <div className="flex items-center justify-between rounded-md border border-border/50 bg-card/40 px-2 py-1.5 text-xs">
                <span className="text-muted-foreground">Compaction</span>
                <span className="font-medium tabular-nums">
                  {formatCompactTokens(diagnostics.footprintBefore.totalEstimatedTokens)}
                  {' → '}
                  {formatCompactTokens(diagnostics.footprintAfter.totalEstimatedTokens)}
                  {typeof savedTokens === 'number' && savedTokens > 0
                    ? ` (-${formatCompactTokens(savedTokens)})`
                    : ''}
                </span>
              </div>
            ) : null}
          </section>

          <p className="mt-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            {formatNumber(diagnostics?.counts.messages)} messages ·{' '}
            {formatNumber(diagnostics?.counts.citations)} sources
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
                {diagnostics?.phase === 'too_large'
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
