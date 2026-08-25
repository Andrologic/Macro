import type { ReasoningEffort } from '../../types';

type Translate = (key: string, fallback: string) => string;

export const getReasoningEffortLabel = (
  t: Translate,
  effort: ReasoningEffort
): string => {
  switch (effort) {
    case 'none':
      return t('models.reasoningLevelNone', 'None');
    case 'minimal':
      return t('models.reasoningLevelMinimal', 'Minimal');
    case 'low':
      return t('models.reasoningLevelLow', 'Low');
    case 'medium':
      return t('models.reasoningLevelMedium', 'Medium');
    case 'high':
      return t('models.reasoningLevelHigh', 'High');
    case 'xhigh':
      return t('models.reasoningLevelXHigh', 'X-High');
    case 'max':
      return t('models.reasoningLevelMax', 'Max');
    default:
      return effort;
  }
};
