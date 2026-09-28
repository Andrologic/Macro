import { useTranslation } from 'react-i18next';
import type { GenerationAttempt } from '../../services/ai/contracts';

export function GenerationAttemptDetails({ attempts }: { attempts?: GenerationAttempt[] }) {
  const { t } = useTranslation();
  if (!attempts?.length || (attempts.length === 1 && attempts[0].status === 'completed' && attempts[0].rawText === attempts[0].acceptedText)) return null;

  return (
    <details className="mt-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium">
        {t('chat.generationAttempts', { count: attempts.length, defaultValue: '{{count}} generation attempts' })}
      </summary>
      <div className="mt-2 space-y-2">
        {attempts.map((attempt, index) => (
          <div key={attempt.id} data-attempt-id={attempt.id} data-attempt-status={attempt.status} className="rounded border border-border/70 p-2">
            <div className="font-medium">
              {t('chat.generationAttemptNumber', { number: index + 1, defaultValue: 'Attempt {{number}}' })}
              {' · '}
              {t(`chat.generationAttemptStatus.${attempt.status}`)}
              {' · '}
              {attempt.costUsd === null
                ? t('chat.generationAttemptCostUnknown', 'cost unknown')
                : t('chat.generationAttemptCost', { amount: attempt.costUsd, defaultValue: '${{amount}}' })}
            </div>
            {attempt.rawText && (attempt.status !== 'completed' || attempt.rawText !== attempt.acceptedText) && (
              <div className="mt-1 whitespace-pre-wrap break-words">
                {t('chat.generationAttemptRawText', 'Attempt text')}: {attempt.rawText}
              </div>
            )}
            {attempt.acceptedText && attempt.rawText !== attempt.acceptedText && (
              <div className="mt-1 whitespace-pre-wrap break-words">
                {t('chat.generationAttemptAcceptedText', 'Text kept in response')}: {attempt.acceptedText}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
