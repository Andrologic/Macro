import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { notify } from '../ui/toastService';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { isVisibleTerminalTab, useTerminalStore } from '../../stores/useTerminalStore';
import { useAppStore } from '../../stores/useAppStore';
import { getTerminalScopeKey, resolveSelectedTaskTerminalScope } from '../../services/manualTerminalTargets';
import { isManualDraftPendingInitialization } from '../../services/manualDraftInitialization';
import { useTaskStore } from '../../stores/useTaskStore';
import { TerminalViewport } from './TerminalViewport';
import TerminalTargetSplitButton from './TerminalTargetSplitButton';
import terminalRuntime from '../../services/terminalRuntime';

interface TerminalPanelProps {
  className?: string;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const tabs = useTerminalStore((state) => state.tabs);
  const tabOrder = useTerminalStore((state) => state.tabOrder);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const activeTabIdByScope = useTerminalStore((state) => state.activeTabIdByScope);
  const activateTab = useTerminalStore((state) => state.activateTab);
  const createManualTab = useTerminalStore((state) => state.createManualTab);
  const openManualTabForProject = useTerminalStore((state) => state.openManualTabForProject);
  const rememberManualProjectForTask = useTerminalStore((state) => state.rememberManualProjectForTask);
  const lastManualProjectIdByTaskId = useTerminalStore((state) => state.lastManualProjectIdByTaskId);
  const reconnectTab = useTerminalStore((state) => state.reconnectTab);
  const writeInput = useTerminalStore((state) => state.writeInput);
  const resizeTab = useTerminalStore((state) => state.resizeTab);
  const clearTab = useTerminalStore((state) => state.clearTab);
  const closeTab = useTerminalStore((state) => state.closeTab);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const standaloneProjects = useAppStore((state) => state.standaloneProjects ?? []);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const tasks = useTaskStore((state) => state.tasks);
  const panelRef = useRef<HTMLElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [tabStripOverflow, setTabStripOverflow] = useState({ left: false, right: false });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState({ matchIndex: -1, matchCount: 0 });

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks]
  );
  const manualDraftPendingInitialization = useMemo(
    () => isManualDraftPendingInitialization(selectedTask),
    [selectedTask]
  );
  const terminalScope = useMemo(
    () =>
      resolveSelectedTaskTerminalScope({
        standaloneProjects,
        projectGroups,
        selectedGroupId,
        selectedProjectId,
        selectedTask,
        lastManualProjectIdByTaskId,
      }),
    [lastManualProjectIdByTaskId, projectGroups, selectedGroupId, selectedProjectId, selectedTask, standaloneProjects]
  );
  const orderedTabs = useMemo(
    () =>
      terminalScope
        ? tabOrder
            .map((tabId) => tabs[tabId])
            .filter(
              (tab): tab is NonNullable<typeof tab> =>
                Boolean(tab) &&
                tab.taskId === terminalScope.taskId &&
                tab.projectId === terminalScope.projectId &&
                isVisibleTerminalTab(tab)
            )
        : [],
    [tabOrder, tabs, terminalScope]
  );
  const activeVisibleTabId = useMemo(
    () => {
      if (!terminalScope || orderedTabs.length === 0) {
        return null;
      }

      const visibleTabIds = new Set(orderedTabs.map((tab) => tab.id));
      const scopedActiveTabId = activeTabIdByScope[getTerminalScopeKey(
        terminalScope.taskId,
        terminalScope.projectId
      )];
      if (scopedActiveTabId && visibleTabIds.has(scopedActiveTabId)) {
        return scopedActiveTabId;
      }

      if (activeTabId && visibleTabIds.has(activeTabId)) {
        return activeTabId;
      }

      return orderedTabs[0]?.id ?? null;
    },
    [activeTabId, activeTabIdByScope, orderedTabs, terminalScope]
  );
  const activeTab = useMemo(
    () => orderedTabs.find((tab) => tab.id === activeVisibleTabId) ?? orderedTabs[0] ?? null,
    [activeVisibleTabId, orderedTabs]
  );
  const hasAnyTabForSelectedTask = useMemo(
    () =>
      terminalScope
        ? tabOrder.some((tabId) => tabs[tabId]?.taskId === terminalScope.taskId)
        : false,
    [tabOrder, tabs, terminalScope]
  );
  const disabledTerminalTitle = manualDraftPendingInitialization
    ? t(
        'terminal.manualDraftUnavailable',
        'Send a first message to name this feature and initialize its terminal.'
      )
    : t('implement.selectTaskToStart', 'Select a task to start implementation.');

  const runTerminalSearch = (
    query: string,
    direction: 'next' | 'previous',
    currentIndex: number | null = searchResult.matchIndex
  ) => {
    if (!activeTab) {
      setSearchResult({ matchIndex: -1, matchCount: 0 });
      return;
    }

    const result = terminalRuntime.searchTab(activeTab.id, query, direction, currentIndex, {
      focusTerminal: false,
    });
    setSearchResult(result);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const updateSearchQuery = (value: string) => {
    setSearchQuery(value);
    runTerminalSearch(value, 'next', null);
  };

  const closeSearch = () => {
    if (activeTab) {
      terminalRuntime.clearSearch(activeTab.id);
    }
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResult({ matchIndex: -1, matchCount: 0 });
  };

  useEffect(() => {
    if (!searchOpen) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [activeTab?.id, searchOpen]);

  useEffect(() => {
    if (!searchOpen || !activeTab) {
      return;
    }

    runTerminalSearch(searchQuery, 'next', null);
    // Search should refresh when the active terminal changes without re-running on every result update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isFindShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && key === 'f';
      const activeElement = document.activeElement;
      const panelHasFocus =
        activeElement instanceof Node &&
        Boolean(panelRef.current?.contains(activeElement));

      if (isFindShortcut && panelHasFocus) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        return;
      }

      if (searchOpen && event.key === 'Escape' && panelHasFocus) {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
    // The handler needs the current active tab/search state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, searchOpen]);

  useEffect(() => {
    const container = tabStripRef.current;
    if (!container) {
      setTabStripOverflow({ left: false, right: false });
      return;
    }

    const updateOverflow = () => {
      const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
      setTabStripOverflow({
        left: container.scrollLeft > 4,
        right: maxScrollLeft - container.scrollLeft > 4,
      });
    };

    updateOverflow();

    const resizeObserver = new ResizeObserver(() => {
      updateOverflow();
    });
    resizeObserver.observe(container);

    container.addEventListener('scroll', updateOverflow, { passive: true });
    window.addEventListener('resize', updateOverflow);

    return () => {
      resizeObserver.disconnect();
      container.removeEventListener('scroll', updateOverflow);
      window.removeEventListener('resize', updateOverflow);
    };
  }, [orderedTabs.length, activeVisibleTabId]);

  const runAction = (action: () => Promise<unknown>) => {
    void action().catch((error) => {
      const message =
        error instanceof Error ? error.message : t('common.error', 'An error occurred');
      notify.error(message);
    });
  };

  const handleQuickOpen = () => {
    if (!terminalScope) {
      return;
    }

    if (terminalScope.preferredProjectId !== terminalScope.projectId) {
      setSelectedProject(terminalScope.preferredProjectId);
    }

    runAction(() =>
      createManualTab({
        projectId: terminalScope.preferredProjectId,
        groupId: terminalScope.groupId,
      })
    );
  };

  const handleProjectSelect = (projectId: string) => {
    if (!terminalScope) {
      return;
    }

    rememberManualProjectForTask(terminalScope.taskId, projectId);
    setSelectedProject(projectId);
    runAction(() => openManualTabForProject({ projectId, groupId: terminalScope.groupId }));
  };

  if (!terminalScope) {
    return (
      <div
        className={cn('h-full border-t border-border/60 bg-background', className)}
        data-tour-id="terminal-panel"
      >
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div className="flex max-w-md flex-col items-center gap-3">
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">
                {manualDraftPendingInitialization
                  ? t('terminal.manualDraftBlockedTitle', 'Feature initialization required')
                  : t('implement.selectTaskShort', 'Select a task')}
              </div>
              <p className="text-sm text-muted-foreground">
                {manualDraftPendingInitialization
                  ? t(
                      'terminal.manualDraftBlockedDescription',
                      'Send a first message to name this feature and initialize its terminal.'
                    )
                  : t('implement.selectTaskToStart', 'Select a task to start implementation.')}
              </p>
            </div>
            <TerminalTargetSplitButton
              variant="empty"
              icon="plus"
              label={t('terminal.newTerminal', 'New terminal')}
              title={disabledTerminalTitle}
              disabled
              projects={[]}
              preferredProjectId={null}
              focusedProjectId={null}
              onPrimaryClick={() => undefined}
              onProjectSelect={() => undefined}
            />
          </div>
        </div>
      </div>
    );
  }

  if (!activeTab) {
    const showMultiProjectPrompt = !hasAnyTabForSelectedTask && terminalScope.projects.length > 1;

    return (
      <div
        className={cn('h-full border-t border-border/60 bg-background', className)}
        data-tour-id="terminal-panel"
      >
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          {showMultiProjectPrompt && (
            <p className="max-w-md text-sm text-muted-foreground">
              {t(
                'terminal.chooseProjectBeforeOpen',
                'Please choose which sub-project to open in a terminal with the plus button.'
              )}
            </p>
          )}
          {hasAnyTabForSelectedTask && (
            <p className="text-sm text-muted-foreground">
              {t(
                'terminal.noTerminalForSubProject',
                'No terminal is open for this sub-project in the selected task.'
              )}
            </p>
          )}
          {!hasAnyTabForSelectedTask && !showMultiProjectPrompt && (
            <p className="text-sm text-muted-foreground">
              {t(
                'terminal.openWithPlus',
                'Open a terminal with the plus button.'
              )}
            </p>
          )}
          <TerminalTargetSplitButton
            variant="empty"
            icon="plus"
            label={t('terminal.newTerminal', 'New terminal')}
            title={t('terminal.newTerminal', 'New terminal')}
            disabled={!terminalScope}
            projects={terminalScope.projects}
            preferredProjectId={terminalScope.preferredProjectId}
            focusedProjectId={terminalScope.projectId}
            onPrimaryClick={handleQuickOpen}
            onProjectSelect={handleProjectSelect}
          />
        </div>
      </div>
    );
  }

  return (
    <section
      ref={panelRef}
      className={cn('flex h-full min-h-0 flex-col border-t border-border/60 bg-background', className)}
      data-tour-id="terminal-panel"
    >
      <header className="flex h-11 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="relative min-w-0 flex-1">
          <div
            ref={tabStripRef}
            className="macro-terminal-tabs-scroll flex min-w-0 items-center gap-2 overflow-x-auto"
          >
            {orderedTabs.map((tab) => {
              const isActive = tab.id === activeTab.id;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    'group inline-flex h-8 min-w-0 max-w-[280px] shrink-0 items-center overflow-hidden rounded-md border text-xs transition-colors',
                    isActive
                      ? 'border-primary/30 bg-primary/10 text-foreground'
                      : 'border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => activateTab(tab.id)}
                    title={tab.title}
                    className="inline-flex min-w-0 max-w-[248px] items-center gap-2 overflow-hidden py-0 pl-3 pr-2"
                  >
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        tab.status === 'running'
                          ? 'bg-amber-400'
                          : tab.hasLiveSession
                            ? 'bg-emerald-400'
                            : 'bg-muted-foreground/60'
                      )}
                    />
                    <span className="min-w-0 truncate text-left">{tab.title}</span>
                    {tab.hasUnreadOutput && !isActive && (
                      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      runAction(async () => {
                        await closeTab(tab.id);
                        terminalRuntime.disposeTab(tab.id);
                      })
                    }
                    className={cn(
                      'inline-flex h-5 shrink-0 items-center justify-center overflow-hidden rounded-sm p-0 text-muted-foreground transition-all hover:bg-accent hover:text-foreground',
                      isActive
                        ? 'mr-1 w-5 opacity-100'
                        : 'w-0 opacity-0 group-hover:pointer-events-auto group-hover:mr-1 group-hover:w-5 group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:mr-1 focus-visible:w-5 focus-visible:opacity-100'
                    )}
                    title={t('common.close', 'Close')}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <div
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background/95 to-transparent transition-opacity',
              tabStripOverflow.left ? 'opacity-100' : 'opacity-0'
            )}
          />
          <div
            className={cn(
              'pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background/95 to-transparent transition-opacity',
              tabStripOverflow.right ? 'opacity-100' : 'opacity-0'
            )}
          />
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t('terminal.search', 'Search terminal')}
            aria-label={t('terminal.search', 'Search terminal')}
          >
            <Icon name="search" size={14} />
          </button>
          <button
            type="button"
            onClick={() => runAction(() => clearTab(activeTab.id))}
            disabled={!activeTab.hasLiveSession}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            title={t('terminal.clear', 'Clear terminal')}
            aria-label={t('terminal.clear', 'Clear terminal')}
          >
            <Icon name="trash" size={14} />
          </button>
          <TerminalTargetSplitButton
            variant="icon"
            icon="plus"
            title={t('terminal.newTerminal', 'New terminal')}
            disabled={!terminalScope}
            projects={terminalScope.projects}
            preferredProjectId={terminalScope.preferredProjectId}
            focusedProjectId={terminalScope.projectId}
            onPrimaryClick={handleQuickOpen}
            onProjectSelect={handleProjectSelect}
          />
        </div>
      </header>

      {!activeTab.hasLiveSession && (
        <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-background/95 px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-foreground">
              <Icon name="alert-circle" size={12} />
              {t('terminal.disconnected', 'Disconnected session')}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                'terminal.disconnectedDescription',
                'This tab was restored from history. Start a new live shell to continue interacting.'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => runAction(() => reconnectTab(activeTab.id))}
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Icon name="refresh-cw" size={12} />
            {t('terminal.reconnect', 'Reconnect')}
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {searchOpen && (
          <div className="absolute right-3 top-3 z-10 flex h-9 max-w-[min(520px,calc(100%-1.5rem))] items-center gap-1 rounded-md border border-border/80 bg-background/95 px-2 shadow-lg">
            <Icon name="search" size={13} className="shrink-0 text-muted-foreground" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => updateSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  runTerminalSearch(searchQuery, event.shiftKey ? 'previous' : 'next');
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeSearch();
                }
              }}
              placeholder={t('terminal.searchPlaceholder', 'Search terminal')}
              className="h-7 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
            <span className="min-w-[3.5rem] text-right text-[11px] tabular-nums text-muted-foreground">
              {searchQuery.trim()
                ? searchResult.matchCount > 0
                  ? `${searchResult.matchIndex + 1}/${searchResult.matchCount}`
                  : '0/0'
                : ''}
            </span>
            <button
              type="button"
              onClick={() => runTerminalSearch(searchQuery, 'previous')}
              disabled={!searchQuery.trim() || searchResult.matchCount === 0}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              title={t('terminal.searchPrevious', 'Previous match')}
              aria-label={t('terminal.searchPrevious', 'Previous match')}
            >
              <Icon name="arrow-up" size={13} />
            </button>
            <button
              type="button"
              onClick={() => runTerminalSearch(searchQuery, 'next')}
              disabled={!searchQuery.trim() || searchResult.matchCount === 0}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              title={t('terminal.searchNext', 'Next match')}
              aria-label={t('terminal.searchNext', 'Next match')}
            >
              <Icon name="arrow-down" size={13} />
            </button>
            <button
              type="button"
              onClick={closeSearch}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t('common.close', 'Close')}
              aria-label={t('common.close', 'Close')}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        )}
        <TerminalViewport
          tab={activeTab}
          onInput={(input) => {
            void writeInput(activeTab.id, input).catch((error) => {
              const message =
                error instanceof Error ? error.message : t('common.error', 'An error occurred');
              notify.error(message);
            });
          }}
          onResize={(cols, rows) => {
            if (!activeTab.hasLiveSession) {
              return;
            }
            void resizeTab(activeTab.id, cols, rows).catch(() => undefined);
          }}
          onClear={() => {
            if (!activeTab.hasLiveSession) {
              return;
            }
            void clearTab(activeTab.id).catch((error) => {
              const message =
                error instanceof Error ? error.message : t('common.error', 'An error occurred');
              notify.error(message);
            });
          }}
        />
      </div>
    </section>
  );
};

export default TerminalPanel;
