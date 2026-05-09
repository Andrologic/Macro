import React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from '../ui/Icon';

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
      data-index={virtualItem.index}
      className="absolute left-0 top-0 w-full py-3"
      style={{ transform: `translateY(${virtualItem.start}px)` }}
      role="separator"
      aria-label={t('chat.compactionBoundary', 'Contexte compacté')}
    >
      <div className="flex items-center gap-3 text-[11px] font-medium text-muted-foreground/80">
        <span className="h-px flex-1 bg-border/50" aria-hidden="true" />
        <span className="bg-background px-2">
          {t('chat.compactionBoundary', 'Contexte compacté')}
        </span>
        <span className="h-px flex-1 bg-border/50" aria-hidden="true" />
      </div>
    </div>
  );
};

export const CompactionProgressNotice: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10">
        <Icon name="loader" size={12} className="animate-spin text-primary" />
      </span>
      <div className="min-w-0">
        <div className="font-medium leading-snug text-foreground">
          {t('chat.compactionProgressTitle', 'Compression du contexte en cours...')}
        </div>
        <div className="mt-0.5 leading-relaxed">
          {t(
            'chat.compactionProgressDescription',
            'Macro prépare une version plus légère de l’historique avant de contacter le modèle.',
          )}
        </div>
      </div>
    </div>
  );
};
