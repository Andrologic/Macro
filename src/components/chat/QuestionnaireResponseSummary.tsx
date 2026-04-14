import React from 'react';
import { useTranslation } from 'react-i18next';
import type { QuestionnaireResponseSummary as QuestionnaireResponseSummaryPayload } from '../../types';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';

interface QuestionnaireResponseSummaryProps {
  summary: QuestionnaireResponseSummaryPayload;
}

export const QuestionnaireResponseSummary: React.FC<QuestionnaireResponseSummaryProps> = ({
  summary,
}) => {
  const { t } = useTranslation();

  return (
    <div
      data-testid="questionnaire-response-summary"
      className="space-y-3.5"
    >
      <div className="flex items-center gap-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        <Icon name="message-circle" size={13} className="shrink-0 text-primary/75" />
        <span className="truncate">
          {t('chat.questionnaireResponseSummaryTitle', 'Reponses au questionnaire')}
        </span>
      </div>
      <div className="space-y-3">
        {summary.items.map((item, index) => (
          <div
            key={item.id}
            className={cn(
              'relative pl-4',
              index > 0 && 'pt-3'
            )}
          >
            <span className="absolute left-0 top-0 h-full w-px bg-border/55" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {item.prompt}
              </p>
              <p className="mt-1.5 break-words text-sm leading-6 text-foreground">
                {item.answer}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
