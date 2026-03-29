import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../ui/Toaster';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useAppStore } from '../../stores/useAppStore';
import { getTerminalScopeKey, resolveSelectedTaskTerminalScope } from '../../services/manualTerminalTargets';
import { isManualDraftPendingInitialization } from '../../services/manualDraftInitialization';
import { useTaskStore } from '../../stores/useTaskStore';
import { TerminalViewport } from './TerminalViewport';
import TerminalTargetSplitButton from './TerminalTargetSplitButton';

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
  const closeTab = useTerminalStore((state) => state.closeTab);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const tasks = useTaskStore((state) => state.tasks);

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
        projectGroups,
        selectedGroupId,
        selectedProjectId,
        selectedTask,
        lastManualProjectIdByTaskId,
      }),
    [lastManualProjectIdByTaskId, projectGroups, selectedGroupId, selectedProjectId, selectedTask]
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
                tab.projectId === terminalScope.projectId
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

  const runAction = (action: () => Promise<unknown>) => {
    void action().catch((error) => {
      const message =
        error instanceof Error ? error.message : t('common.error', 'An error occurred');
      toast.error(message);
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
      <div className={cn('h-full border-t border-border/60 bg-card/40', className)}>
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
      <div className={cn('h-full border-t border-border/60 bg-card/40', className)}>
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
    <section className={cn('flex h-full min-h-0 flex-col border-t border-border/60 bg-card/40', className)}>
      <header className="flex h-11 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          {orderedTabs.map((tab) => {
            const isActive = tab.id === activeTab.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  'group inline-flex h-8 min-w-0 max-w-[240px] shrink-0 items-center gap-1 overflow-hidden rounded-md border pr-1 text-xs transition-colors',
                  isActive
                    ? 'border-primary/30 bg-primary/10 text-foreground'
                    : 'border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <button
                  type="button"
                  onClick={() => activateTab(tab.id)}
                  title={tab.title}
                  className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-3"
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
                  <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>
                  {tab.hasUnreadOutput && !isActive && (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => runAction(() => closeTab(tab.id))}
                  className="hidden shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground group-hover:inline-flex"
                  title={t('common.close', 'Close')}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          {!activeTab.hasLiveSession && (
            <button
              type="button"
              onClick={() => runAction(() => reconnectTab(activeTab.id))}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-foreground hover:bg-accent"
            >
              <Icon name="refresh-cw" size={12} />
              {t('terminal.reconnect', 'Reconnect')}
            </button>
          )}
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

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <TerminalViewport
          tab={activeTab}
          onInput={(input) => {
            void writeInput(activeTab.id, input).catch((error) => {
              const message =
                error instanceof Error ? error.message : t('common.error', 'An error occurred');
              toast.error(message);
            });
          }}
          onResize={(cols, rows) => {
            if (!activeTab.hasLiveSession) {
              return;
            }
            void resizeTab(activeTab.id, cols, rows).catch(() => undefined);
          }}
        />

        {!activeTab.hasLiveSession && (
          <div className="absolute inset-x-4 top-4 flex justify-end">
            <div className="max-w-sm rounded-lg border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground shadow-lg">
              <div className="mb-2 flex items-center gap-2 text-foreground">
                <Icon name="alert-circle" size={12} />
                {t('terminal.disconnected', 'Disconnected session')}
              </div>
              <p>
                {t(
                  'terminal.disconnectedDescription',
                  'This tab was restored from history. Start a new live shell to continue interacting.'
                )}
              </p>
              <button
                type="button"
                onClick={() => runAction(() => reconnectTab(activeTab.id))}
                className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Icon name="refresh-cw" size={12} />
                {t('terminal.reconnect', 'Reconnect')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

export default TerminalPanel;
