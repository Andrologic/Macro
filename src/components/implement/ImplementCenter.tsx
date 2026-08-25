import React from 'react';
import { useTranslation } from 'react-i18next';
import ChatZone from '../chat/ChatZone';
import { PanelResizer } from '../layout/PanelResizer';
import { Icon } from '../ui/Icon';
import { notify } from '../ui/toastService';
import { cn } from '../../utils/cn';
import { isVisibleTerminalTab, useTerminalStore } from '../../stores/useTerminalStore';
import { useAppStore } from '../../stores/useAppStore';
import { getTerminalScopeKey, resolveSelectedTaskTerminalScope } from '../../services/manualTerminalTargets';
import { isManualDraftPendingInitialization } from '../../services/manualDraftInitialization';
import {
  isProjectWorkspaceMissing,
  resolveProjectWorkspaceState,
} from '../../services/projectWorkspaceState';
import { useTaskStore } from '../../stores/useTaskStore';
import TerminalPanel from '../terminal/TerminalPanel';

export const ImplementCenter: React.FC = () => {
  const { t } = useTranslation();
  const panelOpen = useTerminalStore((state) => state.panelOpen);
  const panelHeight = useTerminalStore((state) => state.panelHeight);
  const tabs = useTerminalStore((state) => state.tabs);
  const tabOrder = useTerminalStore((state) => state.tabOrder);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const activeTabIdByScope = useTerminalStore((state) => state.activeTabIdByScope);
  const createManualTab = useTerminalStore((state) => state.createManualTab);
  const lastManualProjectIdByTaskId = useTerminalStore((state) => state.lastManualProjectIdByTaskId);
  const setPanelOpen = useTerminalStore((state) => state.setPanelOpen);
  const setPanelHeight = useTerminalStore((state) => state.setPanelHeight);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const standaloneProjects = useAppStore((state) => state.standaloneProjects);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const tasks = useTaskStore((state) => state.tasks);

  const selectedTask = React.useMemo(
    () => (tasks.find((task) => task.id === selectedTaskId) ?? null),
    [selectedTaskId, tasks]
  );
  const manualDraftPendingInitialization = React.useMemo(
    () => isManualDraftPendingInitialization(selectedTask),
    [selectedTask]
  );
  const terminalScope = React.useMemo(
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
  const workspaceState = React.useMemo(
    () =>
      resolveProjectWorkspaceState({
        standaloneProjects,
        projectGroups,
        selectedGroupId,
        selectedProjectId,
      }),
    [projectGroups, selectedGroupId, selectedProjectId, standaloneProjects]
  );
  const isWorkspaceMissing = isProjectWorkspaceMissing(workspaceState);
  const hasAnyTabForSelectedTask = React.useMemo(
    () =>
      terminalScope
        ? tabOrder.some((tabId) => tabs[tabId]?.taskId === terminalScope.taskId)
        : false,
    [tabOrder, tabs, terminalScope]
  );
  const visibleTerminalTabs = React.useMemo(
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
  const hiddenTerminalTabCount = React.useMemo(() => {
    if (!terminalScope) {
      return 0;
    }

    if (visibleTerminalTabs.length === 0) {
      return 0;
    }

    const visibleTabIds = new Set(visibleTerminalTabs.map((tab) => tab.id));
    const scopedActiveTabId = activeTabIdByScope[getTerminalScopeKey(
      terminalScope.taskId,
      terminalScope.projectId
    )];
    const resolvedActiveTabId =
      (scopedActiveTabId && visibleTabIds.has(scopedActiveTabId) ? scopedActiveTabId : null) ||
      (activeTabId && visibleTabIds.has(activeTabId) ? activeTabId : null);

    return visibleTerminalTabs.filter((tab) => {
      if (panelOpen) {
        return tab.id !== resolvedActiveTabId && tab.hasUnreadOutput;
      }
      return tab.hasUnreadOutput || tab.status === 'running';
    }).length;
  }, [activeTabId, activeTabIdByScope, panelOpen, terminalScope, visibleTerminalTabs]);
  const terminalButtonTitle = manualDraftPendingInitialization
    ? t(
        'terminal.manualDraftUnavailable',
        'Send a first message to name this feature and initialize its terminal.'
      )
    : isWorkspaceMissing
      ? workspaceState.kind === 'noProjectAvailable'
        ? t('terminal.addProjectToOpen', 'Ajoutez un projet pour ouvrir un terminal.')
        : t('terminal.selectProjectToOpen', 'Sélectionnez un projet pour ouvrir un terminal.')
    : !selectedTask
      ? t('implement.selectTaskToStart', 'Select a task to start implementation.')
      : t('terminal.title', 'Terminal');

  const handleQuickOpenTerminal = React.useCallback(() => {
    if (!terminalScope) {
      return;
    }

    if (panelOpen) {
      setPanelOpen(false);
      return;
    }

    if (hasAnyTabForSelectedTask) {
      setPanelOpen(true);
      return;
    }

    if (terminalScope.projects.length > 1) {
      setPanelOpen(true);
      return;
    }

    if (terminalScope.preferredProjectId !== terminalScope.projectId) {
      setSelectedProject(terminalScope.preferredProjectId);
    }

    void createManualTab({
      projectId: terminalScope.preferredProjectId,
      groupId: terminalScope.groupId,
    }).catch((error) => {
      const message =
        error instanceof Error ? error.message : t('common.error', 'An error occurred');
      notify.error(message);
    });
  }, [
    createManualTab,
    hasAnyTabForSelectedTask,
    panelOpen,
    setPanelOpen,
    setSelectedProject,
    t,
    terminalScope,
  ]);

  const hiddenTerminalIndicatorLabel =
    hiddenTerminalTabCount > 9 ? '9+' : hiddenTerminalTabCount.toString();

  React.useEffect(() => {
    if (panelOpen && tabOrder.length === 0) {
      setPanelOpen(false);
    }
  }, [panelOpen, setPanelOpen, tabOrder.length]);

  React.useEffect(() => {
    const showingInitialMultiProjectPrompt =
      terminalScope && !hasAnyTabForSelectedTask && terminalScope.projects.length > 1;

    if (
      panelOpen &&
      terminalScope &&
      visibleTerminalTabs.length === 0 &&
      !showingInitialMultiProjectPrompt
    ) {
      setPanelOpen(false);
    }
  }, [hasAnyTabForSelectedTask, panelOpen, setPanelOpen, terminalScope, visibleTerminalTabs.length]);

  const terminalButton = (
    <button
      type="button"
      disabled={!terminalScope}
      onClick={handleQuickOpenTerminal}
      title={terminalButtonTitle}
      data-tour-id="implement-terminal-toggle"
      className={cn(
        'relative inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors',
        !terminalScope
          ? 'cursor-not-allowed border-border bg-card/30 text-muted-foreground/60'
          : panelOpen
            ? 'border-primary/30 bg-primary/10 text-primary'
            : 'border-border bg-card/40 text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <span className="relative inline-flex h-4 w-4 items-center justify-center">
        <Icon name="terminal" size={12} />
        {hiddenTerminalTabCount > 0 && (
          <span
            className="absolute -right-2 -top-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-background bg-primary px-1 text-[8px] font-semibold leading-none text-primary-foreground ring-1 ring-primary/20"
          >
            {hiddenTerminalIndicatorLabel}
          </span>
        )}
      </span>
      {t('terminal.title', 'Terminal')}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('min-h-0 flex flex-col', panelOpen ? 'flex-1' : 'h-full')}>
        {manualDraftPendingInitialization && (
          <div className="mx-3 mt-3 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-sm text-sky-50">
            <div className="flex items-start gap-2">
              <Icon name="alert-circle" size={14} className="mt-0.5 shrink-0 text-sky-300" />
              <p>
                {t(
                  'terminal.manualDraftBanner',
                  'Send a first message to name this feature and initialize its terminal.'
                )}
              </p>
            </div>
          </div>
        )}
        <ChatZone headerActions={terminalButton} />
      </div>

      {panelOpen && (
        <>
          <PanelResizer
            orientation="vertical"
            onResize={(delta) => setPanelHeight(panelHeight - delta)}
            className="w-full"
          />
          <div
            className="shrink-0 min-h-0 overflow-hidden"
            style={{ height: panelHeight }}
          >
            <TerminalPanel />
          </div>
        </>
      )}
    </div>
  );
};

export default ImplementCenter;
