import React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from '../ui/Icon';
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
      data-index={virtualItem.index}
      className="absolute left-0 top-0 w-full py-5"
      style={{ transform: `translateY(${virtualItem.start}px)` }}
      role="separator"
      aria-label={t('chat.compactionBoundary', 'Contexte automatiquement compacté')}
    >
      <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-border" aria-hidden="true" />
        <span className="inline-flex shrink-0 items-center gap-2 bg-background px-3">
          <Icon name="archive" size={13} className="text-muted-foreground/70" />
          {t('chat.compactionBoundary', 'Contexte automatiquement compacté')}
        </span>
        <span className="h-px flex-1 bg-gradient-to-l from-transparent via-border to-border" aria-hidden="true" />
      </div>
    </div>
  );
};

export const CompactionProgressRow: React.FC<{
  virtualItem: CompactionBoundaryVirtualItem;
  measureElement: (el: HTMLElement | null) => void;
  phase?: 'compacting' | 'safety_compacting' | 'overflow_recovery' | 'recovering_overflow';
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
