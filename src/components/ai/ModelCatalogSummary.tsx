import { useTranslation } from 'react-i18next';
import type { AIModel, ProviderConfig } from '../../types';
import { lookupModelCatalogMetadata } from '../../services/modelContextCatalog';

export interface ModelCatalogSummaryProps {
  model: AIModel;
  provider: ProviderConfig;
}

export const ModelCatalogSummary = ({ model, provider }: ModelCatalogSummaryProps) => {
  const { t, i18n } = useTranslation();
  const metadata = lookupModelCatalogMetadata({
    providerType: provider.providerType,
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    modelId: model.id,
  });
  const context = model.contextWindowSource === 'macro_fallback'
    ? metadata?.contextTokens ?? model.contextWindowTokens
    : model.contextWindowTokens ?? metadata?.contextTokens;
  // Chat Completions preserves image parts; ChatGPT projects them to input_image.
  // Copilot's prompt codec currently replaces them with a text placeholder.
  const images = metadata?.images === true &&
    ['openai', 'openrouter', 'chatgpt'].includes(provider.providerType);
  const tools = metadata?.toolCall === true &&
    ['openai', 'openrouter', 'chatgpt', 'copilot'].includes(provider.providerType) &&
    provider.nativeToolCalling === true &&
    model.nativeToolCalling !== false;
  const hasContext = typeof context === 'number' && Number.isFinite(context) && context > 0;
  if (!hasContext && !images && !tools) return null;

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-snug opacity-75">
      {hasContext && (
        <span title={t('chat.modelInfoContextFull', '{{tokens}} token context', {
          tokens: new Intl.NumberFormat(i18n.language).format(context),
        })}>
          {t('chat.modelInfoContext', '{{tokens}} context', {
            tokens: new Intl.NumberFormat(i18n.language, { notation: 'compact', maximumFractionDigits: 1 }).format(context),
          })}
        </span>
      )}
      {hasContext && (images || tools) ? ' ' : null}
      {images && <span>{t('chat.modelInfoImages', 'Images')}</span>}
      {images && tools ? ' ' : null}
      {tools && <span>{t('chat.modelInfoTools', 'Tools')}</span>}
    </span>
  );
};
