import React from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatTranscriptCompactionProgressPhase } from './transcriptItems';

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
      <div className="relative flex min-h-7 items-center justify-center text-[11px] font-medium leading-4 text-muted-foreground/75">
        <span className="chat-compaction-rule chat-compaction-rule--left" aria-hidden="true" />
        <span className="relative shrink-0 bg-background px-2">{t('chat.compactionBoundary', 'Contexte compacté')}</span>
        <span className="chat-compaction-rule chat-compaction-rule--right" aria-hidden="true" />
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

  return (
    <div
      ref={measureElement}
      data-chat-compaction-progress="true"
      data-chat-compaction-progress-phase={phase}
      data-index={virtualItem.index}
      className="absolute left-0 top-0 w-full py-4"
      style={{ transform: `translateY(${virtualItem.start}px)` }}
      role="status"
      aria-live="polite"
      aria-label={t(
        'chat.compactionProgressDescription',
        'Génération du résumé de contexte en cours. Cela peut prendre quelques secondes.',
      )}
    >
      <div className="relative flex min-h-7 items-center justify-center text-xs font-medium leading-4">
        <span className="chat-compaction-rule chat-compaction-rule--left" aria-hidden="true" />
        <span className="chat-compaction-wave-text relative shrink-0 bg-background px-2">
          {t('chat.compactionProgressTitle', 'Compactage du contexte...')}
        </span>
        <span className="chat-compaction-rule chat-compaction-rule--right" aria-hidden="true" />
      </div>
    </div>
  );
};

export const StreamingCompactionActivity: React.FC = () => {
  const { t } = useTranslation();

  return (
    <span
      data-chat-streaming-compaction-activity="true"
      className="ml-1 inline-flex max-w-full items-center text-xs font-medium align-baseline"
      role="status"
      aria-live="polite"
      aria-label={t(
        'chat.compactionProgressDescription',
        'Génération du résumé de contexte en cours. Cela peut prendre quelques secondes.',
      )}
    >
      <span className="chat-compaction-wave-text truncate">
        {t('chat.streamingCompactionActivity', 'Compactage du contexte...')}
      </span>
    </span>
  );
};
