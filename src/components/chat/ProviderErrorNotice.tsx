import { useTranslation } from 'react-i18next';
import type { ChatErrorPresentation } from '../../services/chatErrorPresentation';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/Accordion';
import { Icon } from '../ui/Icon';

export const ProviderErrorNotice = ({ presentation }: { presentation: ChatErrorPresentation }) => {
  const { t } = useTranslation();
  return (
    <div className="my-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-medium">{t('chat.providerErrorTitle', 'The model could not complete this request.')}</p>
          <p className="mt-1 text-muted-foreground">{presentation.retryable
            ? t('chat.providerErrorRetry', 'Try again in a moment.')
            : t('chat.providerErrorSettings', 'Check the model settings before trying again.')}</p>
        </div>
      </div>
      <Accordion type="single" collapsible className="mt-1">
        <AccordionItem value="diagnostics" className="border-0">
          <AccordionTrigger className="py-1.5 text-xs text-muted-foreground">{t('backup.diagnostics', 'Diagnostic details')}</AccordionTrigger>
          <AccordionContent className="pb-1">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{JSON.stringify(presentation, null, 2)}</pre>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
};
