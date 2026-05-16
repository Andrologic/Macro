import React from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatTranscriptCompactionProgressPhase } from './transcriptItems';

export interface CompactionBoundaryVirtualItem {
  index: number;
  start: number;
}

const CompactionRule: React.FC<{
  children: React.ReactNode;
  labelClassName?: string;
}> = ({ children, labelClassName }) => (
  <div className="relative flex min-h-6 items-center justify-center text-xs font-medium leading-4">
    <span className="chat-compaction-rule chat-compaction-rule--left" aria-hidden="true" />
    <span className={`chat-compaction-label relative shrink-0 bg-background px-3 ${labelClassName ?? ''}`}>
      {children}
    </span>
    <span className="chat-compaction-rule chat-compaction-rule--right" aria-hidden="true" />
  </div>
);

export const CompactionBoundaryRow: React.FC<{
  virtualItem: CompactionBoundaryVirtualItem;
  measureElement: (el: HTMLElement | null) => void;
  compactTopSpacing?: boolean;
}> = ({ virtualItem, measureElement, compactTopSpacing = false }) => {
  const { t } = useTranslation();

  return (
    <div
      ref={measureElement}
      data-chat-compaction-boundary="true"
      data-chat-compaction-boundary-orientation="vertical"
      data-index={virtualItem.index}
      className={`absolute left-0 top-0 w-full ${compactTopSpacing ? 'pt-0 pb-2' : 'py-2'}`}
      style={{ transform: `translateY(${virtualItem.start}px)` }}
      role="separator"
      aria-label={t('chat.compactionBoundary', 'Contexte compacté')}
    >
      <CompactionRule labelClassName="text-muted-foreground/70">
        {t('chat.compactionBoundary', 'Contexte compacté')}
      </CompactionRule>
    </div>
  );
};

export const CompactionProgressRow: React.FC<{
  virtualItem: CompactionBoundaryVirtualItem;
  measureElement: (el: HTMLElement | null) => void;
  phase?: ChatTranscriptCompactionProgressPhase;
  compactTopSpacing?: boolean;
}> = ({ virtualItem, measureElement, phase = 'compacting', compactTopSpacing = false }) => {
  const { t } = useTranslation();

  return (
    <div
      ref={measureElement}
      data-chat-compaction-progress="true"
      data-chat-compaction-progress-phase={phase}
      data-index={virtualItem.index}
      className={`absolute left-0 top-0 w-full ${compactTopSpacing ? 'pt-0 pb-2' : 'py-2'}`}
      style={{ transform: `translateY(${virtualItem.start}px)` }}
      role="status"
      aria-live="polite"
      aria-label={t(
        'chat.compactionProgressDescription',
        'Génération du résumé de contexte en cours. Cela peut prendre quelques secondes.',
      )}
    >
      <CompactionRule labelClassName="chat-compaction-wave-text">
        {t('chat.compactionProgressTitle', 'Compactage du contexte...')}
      </CompactionRule>
    </div>
  );
};
