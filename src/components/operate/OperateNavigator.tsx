import { Suspense, lazy, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  selectOperateInbox, type HiddenOperateAgents, type OperateInboxFilter, type OperateRunInput,
} from '../../services/operateInboxModel';
import { subscribeOperateInbox, useOperateInboxStore } from '../../stores/useOperateInboxStore';
import { useArchitectLaunchStore } from '../../stores/useArchitectLaunchStore';
import { cn } from '../../utils/cn';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';
import { PanelEmptyState } from '../shared/PanelEmptyState';
import { Skeleton } from '../shared/Skeleton';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { PanelHeaderIconButton } from '../ui/PanelHeaderIconButton';
import { SearchBar } from '../ui/SearchBar';
import { SidebarMenu, type SidebarMenuPosition } from '../ui/SidebarMenu';
import { OperateRunRowView } from './OperateRunRows';
import { OperateRunAttentionRowView, OperateThreadRowView } from './OperateAttentionRows';
import {
  operateRunExpansionId, operateSectionExpansionId, visibleFinishedRuns, type OperateSectionId,
} from './operateColumnModel';
import { useOperateExpansion } from './useOperateExpansion';

const ArchitectLaunchDialog = lazy(() => import('./ArchitectLaunchDialog'));

const sectionHeaderClass = 'flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-accent/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70';

function Section({ id, label, count, expanded, onToggle, children }: {
  id: OperateSectionId;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const arrows = (event: KeyboardEvent) => {
    if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && (event.key === 'ArrowRight') !== expanded) {
      event.preventDefault(); onToggle();
    }
  };
  const bodyId = `operate-section-${id}`;
  return <section aria-labelledby={`${bodyId}-title`} data-operate-section={id}>
    <h3 id={`${bodyId}-title`}>
      <button type="button" aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} onClick={onToggle} onKeyDown={arrows}
        className={sectionHeaderClass}>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count > 0 && <span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>}
      </button>
    </h3>
    {expanded && <div id={bodyId} className="mt-0.5 space-y-0.5">{children}</div>}
  </section>;
}

const mutedLine = 'px-2 py-1 text-[10px] text-muted-foreground';

function FilterChip({ label, remove, onRemove }: { label: string; remove: string; onRemove: () => void }) {
  return <button type="button" onClick={onRemove} title={remove} aria-label={remove}
    className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] text-foreground hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70">
    <span className="truncate">{label}</span><Icon name="x" size={10} className="shrink-0" /></button>;
}

export interface OperateColumnProps {
  runs: readonly OperateRunInput[];
  filter: OperateInboxFilter;
  hiddenAgents?: HiddenOperateAgents;
  nowMs: number;
  loading: boolean;
  readFailed: boolean;
  setFilter: (filter: OperateInboxFilter) => void;
  onLaunch?: () => void;
}

/** The column itself: classification comes from `selectOperateInbox`, never from here. */
export function OperateColumn({ runs, filter, hiddenAgents, loading, readFailed, setFilter, nowMs, onLaunch }: OperateColumnProps) {
  const { t, i18n } = useAgsdlTranslation();
  const [searchOpen, setSearchOpen] = useState(() => !!filter.query?.trim());
  const [filterMenu, setFilterMenu] = useState<SidebarMenuPosition | null>(null);
  const [showAllFinished, setShowAllFinished] = useState(false);
  const sections = useMemo(() => selectOperateInbox(runs, filter, nowMs, hiddenAgents,
    time => new Date(time).toLocaleString(i18n.resolvedLanguage)), [runs, filter, nowMs, hiddenAgents, i18n.resolvedLanguage]);
  const runKeys = useMemo(() => new Set([...sections.active, ...sections.finished].map(run => run.key)), [sections]);
  const { isExpanded, toggle } = useOperateExpansion(runKeys);

  const query = filter.query?.trim() ?? '';
  const searching = query.length > 0;
  const filtering = !!filter.systemId || !!filter.showHidden;
  const open = (section: OperateSectionId) => searching || isExpanded(operateSectionExpansionId(section));
  const runOpen = (key: string) => searching || isExpanded(operateRunExpansionId(key));
  const noMatches = !sections.attention.length && !sections.active.length && !sections.snoozed.length && !sections.finished.length;
  const systemName = sections.systems.find(system => system.id === filter.systemId)?.label ?? filter.systemId;
  const finished = visibleFinishedRuns(sections.finished, showAllFinished, searching);
  const closeSearch = () => { setFilter({ ...filter, query: undefined }); setSearchOpen(false); };

  const renderRun = (run: (typeof sections.active)[number]) => <OperateRunRowView key={run.key} run={run} nowMs={nowMs}
    expanded={runOpen(run.key)} onToggle={() => toggle(operateRunExpansionId(run.key))} />;

  return <nav className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background"
    aria-label={t('agsdl.shell030.executions')} data-tour-id="operate-executions">
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3"
      onKeyDown={event => { if (event.key === 'Escape' && searchOpen && !event.defaultPrevented) closeSearch(); }}>
      {searchOpen
        ? <SearchBar value={filter.query ?? ''} onChange={value => setFilter({ ...filter, query: value })} placeholder={t('agsdl.inbox.search')}
          className="h-8 min-w-0 flex-1 rounded-md py-1 focus-within:border-border focus-within:ring-0" showClear={false} inputAutoFocus />
        : <div className="flex min-w-0 items-center gap-2">
          <Icon name="workflow" size={15} className="shrink-0 text-primary" />
          <h2 className="truncate text-sm font-semibold text-foreground">{t('agsdl.shell030.executions')}</h2>
        </div>}
      <div className="flex shrink-0 items-center gap-1">
        <PanelHeaderIconButton icon={searchOpen ? 'x' : 'search'} pressed={searchOpen} className={searchOpen ? 'h-8 w-8' : undefined}
          label={searchOpen ? t('agsdl.shell030.close') : t('agsdl.inbox.search')}
          onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)} />
        {!searchOpen && <PanelHeaderIconButton icon="list-filter" label={t('agsdl.inbox.filter')} pressed={filtering || !!filterMenu}
          aria-haspopup="menu" aria-expanded={filterMenu !== null}
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            setFilterMenu(current => current ? null : { left: rect.right - 208, top: rect.bottom + 4 });
          }} />}
      </div>
    </div>
    {onLaunch && <div className="shrink-0 border-b border-border px-3 py-2">
      <Button type="button" size="sm" variant="secondary" className="h-7 w-full rounded-md px-2 py-0 text-xs"
        leftIcon={<Icon name="play" size={12} />} onClick={onLaunch}>{t('agsdl.launch.title')}</Button>
    </div>}
    {filterMenu && <SidebarMenu position={filterMenu} onClose={() => setFilterMenu(null)} aria-label={t('agsdl.inbox.systemFilter')} className="w-52">
      <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">{t('agsdl.inbox.filterSystem')}</p>
      {[{ id: undefined, label: t('agsdl.inbox.allSystems') }, ...sections.systems].map(system => {
        const checked = system.id === filter.systemId;
        return <button key={system.id ?? 'all'} role="menuitemradio" type="button" aria-checked={checked}
          onClick={() => { setFilterMenu(null); setFilter({ ...filter, systemId: system.id }); }}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent">
          <span className="flex w-[11px] shrink-0">{checked && <Icon name="check" size={11} />}</span>
          <span className="min-w-0 flex-1 truncate">{system.label}</span>
        </button>;
      })}
      <div role="separator" className="my-1 h-px bg-border" />
      <button role="menuitemcheckbox" type="button" aria-checked={!!filter.showHidden}
        onClick={() => { setFilterMenu(null); setFilter({ ...filter, showHidden: !filter.showHidden }); }}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent">
        <span className="flex w-[11px] shrink-0">{filter.showHidden && <Icon name="check" size={11} />}</span>
        <span className="min-w-0 flex-1 truncate">{t('agsdl.inbox.showHidden')}</span>
      </button>
    </SidebarMenu>}
    {filtering && <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-1.5">
      {filter.systemId && <FilterChip label={t('agsdl.inbox.chipSystem', { name: systemName })}
        remove={t('agsdl.inbox.removeFilter', { filter: t('agsdl.inbox.chipSystem', { name: systemName }) })}
        onRemove={() => setFilter({ ...filter, systemId: undefined })} />}
      {filter.showHidden && <FilterChip label={t('agsdl.inbox.chipHidden')}
        remove={t('agsdl.inbox.removeFilter', { filter: t('agsdl.inbox.chipHidden') })}
        onRemove={() => setFilter({ ...filter, showHidden: false })} />}
    </div>}

    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2.5">
      {readFailed && <div role="alert" className="mx-1 mb-2 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-400">{t('agsdl.run030.readFailed')}</div>}
      {loading && !runs.length
        ? <div role="status" aria-label={t('agsdl.run030.loading')} className="space-y-1.5 px-1">
          {[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-10" />)}</div>
        : !runs.length
          ? <PanelEmptyState compact icon="workflow" title={t('agsdl.inbox.emptyTitle')} description={t('agsdl.inbox.emptyHint')} />
          : noMatches && (searching || filtering)
            ? <div role="status" className="mx-2 mt-8 text-center">
              <Icon name="search" size={20} className="mx-auto mb-2 text-muted-foreground/45" />
              <p className="text-xs text-muted-foreground">{searching
                ? t('agsdl.inbox.noResultsQuery', { query }) : t('agsdl.inbox.noResultsFilters')}</p>
              {filtering && <button type="button" className="mt-2 rounded text-[11px] text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70"
                onClick={() => setFilter({ ...filter, systemId: undefined, showHidden: false })}>{t('agsdl.inbox.clearFilters')}</button>}
            </div>
            : <div className="space-y-3">
              {(sections.attention.length > 0 || !searching) && <section aria-labelledby="operate-section-attention-title" data-operate-section="attention">
                <h3 id="operate-section-attention-title" className="flex h-7 items-center gap-1.5 px-1.5 text-[11px] font-medium text-muted-foreground">
                  <span className="min-w-0 truncate">{t('agsdl.inbox.attention')}</span>
                  {sections.attention.length > 0 && <Badge variant="warning" size="sm" className="bg-amber-500/10 px-1.5 py-0 text-[10px] text-amber-500">{sections.attention.length}</Badge>}
                </h3>
                <div className="mt-0.5 space-y-0.5">
                  {sections.attention.length === 0 && <p className={mutedLine}>{t('agsdl.inbox.nothingWaiting')}</p>}
                  {sections.attention.map(item => item.kind === 'thread'
                    ? <OperateThreadRowView key={item.key} thread={item} variant="attention" />
                    : <OperateRunAttentionRowView key={item.key} item={item} />)}
                </div>
              </section>}
              {sections.active.length > 0 && <Section id="active" label={t('agsdl.inbox.active')} count={sections.active.length}
                expanded={open('active')} onToggle={() => toggle(operateSectionExpansionId('active'))}>
                {sections.active.map(renderRun)}
              </Section>}
              {sections.snoozed.length > 0 && <Section id="snoozed" label={t('agsdl.inbox.snoozed')} count={sections.snoozed.length}
                expanded={open('snoozed')} onToggle={() => toggle(operateSectionExpansionId('snoozed'))}>
                {sections.snoozed.map(thread => <OperateThreadRowView key={thread.key} thread={thread} variant="snoozed" />)}
              </Section>}
              {sections.finished.length > 0 && <Section id="finished" label={t('agsdl.inbox.finished')} count={sections.finished.length}
                expanded={open('finished')} onToggle={() => toggle(operateSectionExpansionId('finished'))}>
                {finished.shown.map(renderRun)}
                {finished.older > 0 && <button type="button" onClick={() => setShowAllFinished(true)}
                  className="w-full rounded-md px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70">
                  {t('agsdl.inbox.showOlder', { count: finished.older })}</button>}
              </Section>}
              {!searching && <Section id="scheduled" label={t('agsdl.inbox.scheduled')} count={sections.scheduled.length}
                expanded={open('scheduled')} onToggle={() => toggle(operateSectionExpansionId('scheduled'))}>
                {/* Programmations (lot F): rows arrive with the scheduler; until then the section explains itself. */}
                {sections.scheduled.length === 0 && <p className={cn(mutedLine)}>{t('agsdl.inbox.scheduledEmpty')}</p>}
              </Section>}
            </div>}
    </div>
  </nav>;
}

export default function OperateNavigator() {
  const state = useOperateInboxStore();
  const launchWindow = useArchitectLaunchStore(state => state.window);
  const openLaunch = useArchitectLaunchStore(state => state.open);
  useEffect(subscribeOperateInbox, []);
  return <>
    <OperateColumn runs={state.runs} filter={state.filter} hiddenAgents={state.hiddenAgents} nowMs={state.nowMs}
      loading={state.loading} readFailed={state.readFailed} setFilter={state.setFilter} onLaunch={() => openLaunch()} />
    {launchWindow && <Suspense fallback={null}><ArchitectLaunchDialog
      key={JSON.stringify(launchWindow.version ?? null)} initialVersion={launchWindow.version} /></Suspense>}
  </>;
}
