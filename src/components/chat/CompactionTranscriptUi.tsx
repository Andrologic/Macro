import React from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatTranscriptCompactionProgressPhase } from './transcriptItems';
import { SpinnerIcon } from '../ui/SpinnerIcon';

export interface CompactionBoundaryVirtualItem {
  index: number;
  start: number;
}

export const CompactionBoundaryRow: React.FC<{
  virtualItem: CompactionBoundaryVirtualItem;
  measureElement: (el: HTMLElement | null) => void;
}> = ({ virtualItem, measureElement }) => {
  const { t } = useTranslation();

  return (
    <div
      ref={measureElement}
      data-chat-compaction-boundary="true"
      data-chat-compaction-boundary-orientation="vertical"
      data-index={virtualItem.index}
      className="absolute left-0 top-0 w-full py-4"
      style={{ transform: `translateY(${virtualItem.start}px)` }}
      role="separator"
      aria-label={t('chat.compactionBoundary', 'Contexte compacté')}
    >
      <div className="flex min-h-10 items-center text-[11px] font-medium text-muted-foreground/85">
        <span className="relative ml-1 inline-flex min-h-10 items-center gap-3">
          <span
            className="absolute left-1.5 top-0 h-full w-px bg-gradient-to-b from-transparent via-primary/45 to-border/70"
            aria-hidden="true"
          />
          <span
            className="relative z-10 flex h-3 w-3 items-center justify-center rounded-full border border-primary/30 bg-background"
            aria-hidden="true"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-primary/70" />
          </span>
          <span className="relative z-10 inline-flex shrink-0 rounded-full border border-border/60 bg-background/95 px-2 py-0.5 shadow-sm">
            {t('chat.compactionBoundary', 'Contexte compacté')}
          </span>
        </span>
      </div>
    </div>
  );
};

export const CompactionProgressRow: React.FC<{
  virtualItem: CompactionBoundaryVirtualItem;
  measureElement: (el: HTMLElement | null) => void;
  phase?: ChatTranscriptCompactionProgressPhase;
}> = ({ virtualItem, measureElement, phase = 'compacting' }) => {
  const { t } = useTranslation();
  const isOverflowRecovery =
    phase === 'overflow_recovery' || phase === 'recovering_overflow';
  const isSafetyPrestream = phase === 'safety_compacting';

  return (
    <div
      ref={measureElement}
      data-chat-compaction-progress="true"
      data-index={virtualItem.index}
      className="absolute left-0 top-0 w-full py-4"
      style={{ transform: `translateY(${virtualItem.start}px)` }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/30 to-primary/30" aria-hidden="true" />
        <span className="inline-flex max-w-[min(34rem,calc(100%-3rem))] shrink-0 items-center gap-2 rounded-full border border-primary/20 bg-background px-3 py-1.5 text-primary shadow-sm">
          <SpinnerIcon size={13} />
          <span className="truncate">
            {isOverflowRecovery
              ? t('chat.compactionOverflowProgress', 'Récupération après dépassement de contexte...')
              : isSafetyPrestream
                ? t('chat.compactionSafetyProgress', 'Compression nécessaire avant envoi...')
              : t('chat.compactionProgressTitle', 'Compression du contexte en cours...')}
          </span>
        </span>
        <span className="h-px flex-1 bg-gradient-to-l from-transparent via-primary/30 to-primary/30" aria-hidden="true" />
      </div>
    </div>
  );
};

export const StreamingCompactionActivity: React.FC = () => {
  const { t } = useTranslation();

  return (
    <span
      data-chat-streaming-compaction-activity="true"
      className="ml-1 inline-flex max-w-full items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary align-baseline shadow-sm"
      role="status"
      aria-live="polite"
    >
      <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-visible">
        <span
          className="chat-streaming-compaction__wave absolute h-7 w-7 rounded-full"
          aria-hidden="true"
        />
        <span className="relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-primary/20 bg-background/85">
          <SpinnerIcon size={12} className="text-primary" />
        </span>
      </span>
      <span className="truncate">
        {t('chat.streamingCompactionActivity', 'Compactage du contexte en cours...')}
      </span>
    </span>
  );
};
