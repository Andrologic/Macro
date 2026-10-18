import { useTranslation } from 'react-i18next';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { PLAN_ICONS, type PlanIcon } from '../../services/planIcon';

interface Props {
  value?: string;
  isLoading: boolean;
  error: string | null;
  onSelect: (icon: PlanIcon | null) => void;
  onClose: () => void;
}

export function PlanIconDialog({ value, isLoading, error, onSelect, onClose }: Props) {
  const { t } = useTranslation();
  const title = t('architect.planIcon.title', 'Choose an icon');
  return <Dialog title={title} onClose={isLoading ? () => undefined : onClose} closeOnBackdropClick={!isLoading}
    panelClassName="flex max-h-[calc(100dvh-2rem)] w-full max-w-[320px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
      <h2 className="flex-1 text-sm font-semibold">{title}</h2>
      <button type="button" disabled={isLoading} aria-label={t('common.close', 'Close')} onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><Icon name="x" size={14} /></button>
    </header>
    <div className="grid max-h-[min(60vh,24rem)] min-h-0 grid-cols-6 gap-2 overflow-y-auto p-4" aria-busy={isLoading}>
      {PLAN_ICONS.map(icon => {
        const label = t(`architect.planIcon.options.${icon}`);
        return <button key={icon} type="button" title={label} aria-label={label} aria-pressed={value === icon} disabled={isLoading} onClick={() => onSelect(icon)}
          className={cn('flex h-9 w-9 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50', value === icon ? 'border-primary/50 bg-primary/15 text-primary' : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground')}>
          <Icon name={icon} size={18} />
        </button>;
      })}
    </div>
    {error && <p role="alert" className="px-4 pb-3 text-xs text-red-400">{error}</p>}
    <footer className="shrink-0 border-t border-border px-4 py-2">
      <button type="button" disabled={isLoading || !value} onClick={() => onSelect(null)} className="inline-flex items-center gap-2 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"><Icon name="rotate-ccw" size={12} />{t('architect.planIcon.reset', 'Default icon')}</button>
    </footer>
  </Dialog>;
}
