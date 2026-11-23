import type { ReactNode } from 'react';
import { formatDate } from '../../i18n/format';
import type { OperateLocation } from '../../services/operateInboxModel';
import { cn } from '../../utils/cn';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';
import { Icon, type IconName } from '../ui/Icon';
import { formatOperateElapsed } from './operateColumnModel';

/** Row and menu classes shared by every Operate row (same values as the Architect navigator). */
export const operateMenuItemClass = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50';
export const operateRowFocusClass = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70';
export const operateRowActionClass = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

export function useOperateFormat() {
  const { i18n } = useAgsdlTranslation();
  const locale = i18n.resolvedLanguage;
  return {
    locale,
    /** "09:00" */
    clock: (ms: number) => formatDate(ms, { hour: '2-digit', minute: '2-digit' }, locale),
    /** "23 nov., 09:00" */
    moment: (ms: number) => formatDate(ms, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, locale),
    /** Full date used as tooltip for every relative time. */
    full: (ms: number) => formatDate(ms, { dateStyle: 'medium', timeStyle: 'short' }, locale),
  };
}

/** Short elapsed time ("12 min"); one column-wide timer re-renders it, never one per row. */
export function OperateElapsed({ ms, at, className }: { ms: number | null; at: number | null; className?: string }) {
  const { t } = useAgsdlTranslation();
  const { locale, full } = useOperateFormat();
  if (ms === null) return null;
  return <time className={cn('shrink-0 text-[10px] tabular-nums text-muted-foreground', className)}
    dateTime={at === null ? undefined : new Date(at).toISOString()} title={at === null ? undefined : full(at)}>
    {formatOperateElapsed(ms, locale) ?? t('agsdl.inbox.justNow')}
  </time>;
}

/** Hidden marker and remote location, the discreet group of line 1. */
export function OperateMarkers({ hidden, location }: { hidden?: boolean; location: OperateLocation }) {
  const { t } = useAgsdlTranslation();
  const remote = location.kind === 'remote' ? location.label : null;
  if (!hidden && !remote) return null;
  return <>
    {hidden && <span title={t('agsdl.inbox.hidden')} className="flex shrink-0 text-muted-foreground">
      <Icon name="eye-off" size={11} /><span className="sr-only">{t('agsdl.inbox.hidden')}</span></span>}
    {remote && <span title={t('agsdl.inbox.onMachine', { machine: remote })}
      className="flex min-w-0 max-w-[4.5rem] shrink items-center gap-0.5 text-[10px] text-muted-foreground">
      <Icon name="server" size={11} className="shrink-0" /><span className="truncate">{remote}</span></span>}
  </>;
}

export function UnreadDot() {
  const { t } = useAgsdlTranslation();
  return <span role="img" aria-label={t('agsdl.inbox.unread')} title={t('agsdl.inbox.unread')} className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />;
}

export function OperateMenuItem({ icon, children, danger, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName; children: ReactNode; danger?: boolean;
}) {
  return <button role="menuitem" type="button" {...props}
    className={cn(operateMenuItemClass, danger && 'text-red-400 hover:bg-red-500/10')}>
    <Icon name={icon} size={11} className="shrink-0" />{children}</button>;
}
