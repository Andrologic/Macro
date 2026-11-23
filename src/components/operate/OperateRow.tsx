import { useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';
import { SidebarMenu, sidebarMenuPosition, type SidebarMenuPosition } from '../ui/SidebarMenu';
import { operateRowActionClass, operateRowFocusClass, UnreadDot } from './OperateColumnParts';
import { operateToneClass, type OperateTone } from './operateColumnModel';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';

export interface OperateRowQuickAction { icon: IconName; label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void }

/**
 * Two-line row of the Operate column: the whole row opens its target, while
 * `detail` stays an independent button ("system · run" opens the run graph).
 * The row-wide button is stretched behind the content instead of wrapping it,
 * because buttons cannot nest.
 */
export function OperateRow({ icon, tone, spin, title, unread, markers, trailing, detail, chip, selected, dimmed, openLabel, openTitle,
  openRef, onOpen, quickAction, menuLabel, renderMenu }: {
  icon: IconName;
  tone: OperateTone;
  spin?: boolean;
  title: string;
  unread?: boolean;
  markers?: ReactNode;
  trailing?: ReactNode;
  detail: ReactNode;
  chip?: ReactNode;
  selected?: boolean;
  dimmed?: boolean;
  openLabel: string;
  openTitle?: string;
  openRef?: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  quickAction?: OperateRowQuickAction;
  menuLabel: string;
  /** Content of the row menu; `close` dismisses it and `position` anchors follow-up menus. */
  renderMenu: (close: () => void, position: SidebarMenuPosition) => ReactNode;
}) {
  const { t } = useAgsdlTranslation();
  const [menu, setMenu] = useState<SidebarMenuPosition | null>(null);
  const open = menu !== null;
  const reveal = 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100';
  return <div data-operate-row
    className={cn('group/row relative flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 transition-colors',
      selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground', dimmed && 'opacity-70')}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu(sidebarMenuPosition(event)); }}>
    <button ref={openRef} type="button" data-operate-open-thread aria-current={selected ? 'page' : undefined}
      aria-label={openLabel} title={openTitle ?? openLabel} onClick={onOpen}
      className={cn('absolute inset-0 rounded-md', operateRowFocusClass)} />
    <Icon name={icon} size={12} className={cn('pointer-events-none relative mt-1 shrink-0', operateToneClass[tone], spin && 'animate-spin')} />
    <div className="pointer-events-none relative min-w-0 flex-1">
      <div className="flex min-h-5 items-center gap-1.5">
        <span className={cn('min-w-0 flex-1 truncate text-xs text-foreground', unread ? 'font-semibold' : 'font-medium')}>{title}</span>
        {unread && <UnreadDot />}
        {markers}
        {trailing && <span className={cn('flex shrink-0 items-center', 'group-hover/row:opacity-0 group-focus-within/row:opacity-0', open && 'opacity-0')}>{trailing}</span>}
      </div>
      <div className="flex min-h-4 items-center gap-2">
        <span className="min-w-0 flex-1 text-left">{detail}</span>
        {chip}
      </div>
    </div>
    <div className={cn('absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded bg-accent', open ? 'opacity-100' : reveal)}>
      {quickAction && <button type="button" onClick={quickAction.onClick} title={quickAction.label} aria-label={quickAction.label}
        className={operateRowActionClass}><Icon name={quickAction.icon} size={11} /></button>}
      <button type="button" aria-haspopup="menu" aria-expanded={open} title={t('agsdl.inbox.rowActions', { name: title })}
        aria-label={t('agsdl.inbox.rowActions', { name: title })} className={operateRowActionClass}
        onClick={event => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu(current => current ? null : { left: rect.right - 208, top: rect.bottom + 4 });
        }}>
        <Icon name="more-horizontal" size={12} />
      </button>
    </div>
    {menu && <SidebarMenu position={menu} onClose={() => setMenu(null)} aria-label={menuLabel} className="w-52">
      {renderMenu(() => setMenu(null), menu)}
    </SidebarMenu>}
  </div>;
}

export const OperateMenuSeparator = () => <div role="separator" className="my-1 h-px bg-border" />;

/** Motive word at the end of line 2, never colour alone. */
export function OperateChip({ label, tone, title }: { label: string; tone: OperateTone; title?: string }) {
  return <span title={title ?? label} className={cn('shrink-0 text-[10px]', operateToneClass[tone])}>{label}</span>;
}

/** "système · exécution": a link to the run graph, kept above the row-wide button. */
export function OperateRunLink({ label, onOpen }: { label: string; onOpen: () => void }) {
  return <button type="button" title={label} onClick={event => { event.stopPropagation(); onOpen(); }}
    className="pointer-events-auto relative z-10 block max-w-full truncate text-left text-[10px] text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70">
    {label}</button>;
}
