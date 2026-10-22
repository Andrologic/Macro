import { useTranslation } from 'react-i18next';
import type { GenerationAttempt } from '../../services/ai/contracts';

export function GenerationAttemptDetails({ attempts }: { attempts?: GenerationAttempt[] }) {
  const { t } = useTranslation();
  if (!attempts?.length) return null;

  return (
    <p className="my-3 px-1 text-xs leading-relaxed text-muted-foreground">
      {t('chat.generationAttempts', { count: attempts.length, defaultValue: '{{count}} generation attempts' })}
    </p>
  );
}
