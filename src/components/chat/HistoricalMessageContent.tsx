import { useTranslation } from 'react-i18next';
import { formatDate } from '../../i18n/format';
import { originalDisplayDate } from '../../services/chatHistoryDisplay';

/** Historical content is readable text, never a questionnaire or tool action. */
export function HistoricalMessageContent({ content, date }: { content: string; date: string | null }) {
  const { t, i18n } = useTranslation();
  const display = originalDisplayDate(date);
  return <>
    <div className="mb-1 text-[10px] text-muted-foreground">
      {display ? <time dateTime={display}>{formatDate(display, { dateStyle: 'medium', timeStyle: 'short' }, i18n.language)}</time>
        : t('chat.historyUnknownDate')}
    </div>
    <div data-chat-historical-message="true" className="whitespace-pre-wrap break-words">{content}</div>
  </>;
}
