import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import * as tauriIpc from '../../services/tauriIpc';
import { resolveProjectExecutionContext } from '../../services/projectExecutionContext';
import { getFocusedProjectForGroup, getSubProjectsForGroup } from '../../services/globalProjects';

type DebugEventType = 'tool' | 'tool_done' | 'error';

interface DebugEvent {
  id: string;
  type: DebugEventType;
  tool?: string;
  details: string;
  timestamp: string;
  messageId: string;
}

interface DebugInspectorProps {
  className?: string;
}

const TOOL_LINE_REGEX = /^\[TOOL\]\s+(.+)$/i;
const TOOL_DONE_LINE_REGEX = /^\[TOOL_DONE\]\s+(.+)$/i;
const ERROR_LINE_REGEX = /^Error:\s*(.+)$/i;
const MAX_VISIBLE_EVENTS = 60;

const getRelativeTime = (timestamp: string, nowLabel: string): string => {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return '';

  const deltaSeconds = Math.floor((Date.now() - parsed) / 1000);
  if (deltaSeconds < 5) return nowLabel;
  if (deltaSeconds < 60) return `${deltaSeconds}s`;

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h`;

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d`;
};

const parseToolName = (payload: string): string => {
  const trimmed = payload.trim();
  const untilSpace = trimmed.split(' ')[0] || trimmed;
  return untilSpace.replace(/\(.*/, '').trim();
};

export const DebugInspector: React.FC<DebugInspectorProps> = ({ className }) => {
  const { t } = useTranslation();
  const translate = React.useCallback(
    (key: string, fallback: string, options?: Record<string, unknown>) =>
      String(t(key, { defaultValue: fallback, ...(options || {}) })),
    [t]
  );
  const mode = useAppStore((state) => state.mode);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const projectRegistryRepairSummary = useAppStore(
    (state) => state.projectRegistryRepairSummary
  );

  const selectedConversationId = useChatStore((state) => state.selectedConversationId);
  const conversations = useChatStore((state) => state.conversations);
  const messages = useChatStore((state) => state.messages);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const isLoading = useChatStore((state) => state.isLoading);
  const chatLastError = useChatStore((state) => state.lastError);
  const tasks = useTaskStore((state) => state.tasks);
  const activeRepositoryPath = useTaskStore((state) => state.activeRepositoryPath);
  const branchWorktrees = useTaskStore((state) => state.branchWorktrees);
  const eventsContainerRef = useRef<HTMLDivElement>(null);
  const [backendWorkspaceRoot, setBackendWorkspaceRoot] = React.useState<string>(
    translate('debug.inspector.unknown', '(unknown)')
  );
  const [localFocusedProjectId, setLocalFocusedProjectId] = React.useState<string | null>(null);
  const [projectRegistryDiagnostics, setProjectRegistryDiagnostics] =
    React.useState<tauriIpc.ProjectRegistryDiagnosticsDto | null>(null);

  const selectedProviderId = useProviderStore((state) => state.selectedProviderId);
  const selectedModelId = useProviderStore((state) => state.selectedModelId);
  const terminalSessions = useTerminalStore((state) => state.sessions);

  const availableProjects = useMemo(
    () => getSubProjectsForGroup(projectGroups, selectedGroupId),
    [projectGroups, selectedGroupId]
  );
  const selectedProject = useMemo(
    () => getFocusedProjectForGroup(projectGroups, selectedGroupId, localFocusedProjectId ?? selectedProjectId),
    [localFocusedProjectId, projectGroups, selectedGroupId, selectedProjectId]
  );

  useEffect(() => {
    setLocalFocusedProjectId(selectedProjectId);
  }, [selectedGroupId, selectedProjectId]);

  const effectiveExecutionContext = useMemo(
    () =>
      resolveProjectExecutionContext({
        mode,
        projects: projectGroups.flatMap((group) => group.projects),
        projectGroups,
        tasks,
        conversations,
        conversationId: selectedConversationId,
        selectedGroupId,
        selectedProjectId: selectedProject?.id ?? selectedProjectId,
        selectedTaskId,
        activeRepositoryPath,
        branchWorktrees,
      }),
    [
      activeRepositoryPath,
      branchWorktrees,
      conversations,
      mode,
      projectGroups,
      selectedConversationId,
      selectedGroupId,
      selectedProject?.id,
      selectedProjectId,
      selectedTaskId,
      tasks,
    ]
  );

  const conversationMessages = useMemo(() => {
    if (!selectedConversationId) return [];
    return messages.filter((message) => message.conversation_id === selectedConversationId);
  }, [messages, selectedConversationId]);

  const debugEvents = useMemo<DebugEvent[]>(() => {
    const events: DebugEvent[] = [];

    for (const message of conversationMessages) {
      if (message.role !== 'assistant') continue;

      if (message.tool_traces && message.tool_traces.length > 0) {
        message.tool_traces.forEach((toolTrace, index) => {
          const details = [toolTrace.tool_name, toolTrace.detail].filter(Boolean).join(' ');
          events.push({
            id: `${message.id}-tool-trace-${index}`,
            type: toolTrace.status === 'running' ? 'tool' : 'tool_done',
            tool: toolTrace.tool_name,
            details,
            timestamp: message.timestamp,
            messageId: message.id,
          });
        });
        continue;
      }

      const lines = message.content.split('\n');
      lines.forEach((line, index) => {
        const normalized = line.trim();
        if (!normalized) return;

        const toolStartMatch = normalized.match(TOOL_LINE_REGEX);
        if (toolStartMatch) {
          const details = toolStartMatch[1].trim();
          events.push({
            id: `${message.id}-tool-${index}`,
            type: 'tool',
            tool: parseToolName(details),
            details,
            timestamp: message.timestamp,
            messageId: message.id,
          });
          return;
        }

        const toolDoneMatch = normalized.match(TOOL_DONE_LINE_REGEX);
        if (toolDoneMatch) {
          const details = toolDoneMatch[1].trim();
          events.push({
            id: `${message.id}-tool-done-${index}`,
            type: 'tool_done',
            tool: parseToolName(details),
            details,
            timestamp: message.timestamp,
            messageId: message.id,
          });
          return;
        }

        const errorMatch = normalized.match(ERROR_LINE_REGEX);
        if (errorMatch) {
          events.push({
            id: `${message.id}-error-${index}`,
            type: 'error',
            details: errorMatch[1].trim(),
            timestamp: message.timestamp,
            messageId: message.id,
          });
        }
      });
    }

    return events.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [conversationMessages]);

  const visibleDebugEvents = useMemo(
    () => debugEvents.slice(0, MAX_VISIBLE_EVENTS),
    [debugEvents]
  );
  const visibleTerminalSessions = useMemo(
    () =>
      Object.values(terminalSessions)
        .sort(
          (left, right) =>
            new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
        )
        .slice(0, 4),
    [terminalSessions]
  );

  useEffect(() => {
    let cancelled = false;

    const loadRuntimeDiagnostics = async () => {
      if (!tauriIpc.isTauriAvailable()) {
        if (!cancelled) {
          setBackendWorkspaceRoot(translate('debug.inspector.browser', '(browser)'));
          setProjectRegistryDiagnostics(null);
        }
        return;
      }

      try {
        const [root, diagnostics] = await Promise.all([
          tauriIpc.workspaceGetActiveRoot(),
          tauriIpc.workspaceGetProjectRegistryDiagnostics(),
        ]);
        if (!cancelled) {
          setBackendWorkspaceRoot(root || translate('debug.inspector.unknown', '(unknown)'));
          setProjectRegistryDiagnostics(diagnostics);
        }
      } catch {
        if (!cancelled) {
          setBackendWorkspaceRoot(translate('debug.inspector.error', '(error)'));
          setProjectRegistryDiagnostics(null);
        }
      }
    };

    void loadRuntimeDiagnostics();

    return () => {
      cancelled = true;
    };
  }, [mode, selectedConversationId, selectedProject?.path, translate]);

  useEffect(() => {
    if (!eventsContainerRef.current) return;
    eventsContainerRef.current.scrollTop = 0;
  }, [visibleDebugEvents.length]);

  const statePills = [
    { label: translate('debug.inspector.mode', 'Mode'), value: mode, icon: 'terminal' as const },
    {
      label: translate('debug.inspector.provider', 'Provider'),
      value: selectedProviderId || translate('debug.inspector.none', '(none)'),
      icon: 'cpu' as const,
    },
    {
      label: translate('debug.inspector.model', 'Model'),
      value: selectedModelId || translate('debug.inspector.none', '(none)'),
      icon: 'sparkles' as const,
    },
    {
      label: translate('debug.inspector.stream', 'Stream'),
      value: isStreaming
        ? translate('debug.inspector.streamActive', 'active')
        : isLoading
          ? translate('debug.inspector.streamLoading', 'loading')
          : translate('debug.inspector.streamIdle', 'idle'),
      icon: 'loader' as const,
    },
  ];

  return (
    <aside className={cn('h-full w-full bg-card border-l border-border flex flex-col', className)}>
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="terminal" size={16} className="text-primary" />
          {translate('debug.inspector.title', 'Debug Inspector')}
        </h1>
        <span className="text-xs text-muted-foreground">
          {translate('debug.inspector.eventsCount', '{{visible}}/{{total}} events', {
            visible: visibleDebugEvents.length,
            total: debugEvents.length,
          })}
        </span>
      </div>

      <div className="border-b border-border p-3 space-y-2">
        <div className="text-xs text-muted-foreground">
          {translate('debug.inspector.runtime', 'Runtime')}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {statePills.map((item) => (
            <div
              key={item.label}
              className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs text-foreground flex items-center gap-1.5"
            >
              <Icon name={item.icon} size={12} className="text-muted-foreground" />
              <span className="text-muted-foreground">{item.label}:</span>
              <span className="truncate">{item.value}</span>
            </div>
          ))}
        </div>

        <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
          <div className="text-muted-foreground mb-0.5">
            {translate('debug.inspector.selectedProjectRoot', 'Selected project root')}
          </div>
          <div className="font-mono text-foreground truncate">
            {selectedProject?.path || translate('debug.inspector.none', '(none)')}
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
          <div className="text-muted-foreground mb-1">
            {translate('debug.inspector.projectRegistry', 'Project registry')}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded bg-card px-2 py-1">
              <div className="text-muted-foreground">
                {translate('debug.inspector.frontendGroups', 'Frontend groups')}
              </div>
              <div className="text-foreground font-medium">{projectGroups.length}</div>
            </div>
            <div className="rounded bg-card px-2 py-1">
              <div className="text-muted-foreground">
                {translate('debug.inspector.frontendProjects', 'Frontend projects')}
              </div>
              <div className="text-foreground font-medium">
                {projectGroups.reduce((total, group) => total + group.projects.length, 0)}
              </div>
            </div>
            <div className="rounded bg-card px-2 py-1">
              <div className="text-muted-foreground">
                {translate('debug.inspector.backendRaw', 'Backend raw')}
              </div>
              <div className="text-foreground font-medium">
                {projectRegistryDiagnostics
                  ? `${projectRegistryDiagnostics.rawGroupCount}/${projectRegistryDiagnostics.rawProjectCount}`
                  : translate('debug.inspector.notAvailable', '(n/a)')}
              </div>
            </div>
            <div className="rounded bg-card px-2 py-1">
              <div className="text-muted-foreground">
                {translate('debug.inspector.backendSanitized', 'Backend sanitized')}
              </div>
              <div className="text-foreground font-medium">
                {projectRegistryDiagnostics
                  ? `${projectRegistryDiagnostics.sanitizedGroupCount}/${projectRegistryDiagnostics.sanitizedProjectCount}`
                  : translate('debug.inspector.notAvailable', '(n/a)')}
              </div>
            </div>
          </div>
          {projectRegistryDiagnostics && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              {translate(
                'debug.inspector.repairSummary',
                'duplicates repaired: {{duplicates}}, mount names assigned: {{mounts}}, empty groups: {{emptyGroups}}, dead nodes: {{deadNodes}}, dead branches: {{deadBranches}}',
                {
                  duplicates: projectRegistryDiagnostics.repairReport.duplicate_paths_removed,
                  mounts: projectRegistryDiagnostics.repairReport.mount_names_assigned,
                  emptyGroups: projectRegistryDiagnostics.repairReport.empty_groups_removed,
                  deadNodes: projectRegistryDiagnostics.repairReport.plan_nodes_removed,
                  deadBranches: projectRegistryDiagnostics.repairReport.predicted_branches_removed,
                }
              )}
            </div>
          )}
          {projectRegistryRepairSummary && (
            <div className="mt-2 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
              {projectRegistryRepairSummary}
            </div>
          )}
        </div>

        {availableProjects.length > 1 && (
          <label className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs flex flex-col gap-1">
            <span className="text-muted-foreground">
              {translate('debug.inspector.repoFocus', 'Debug repo focus')}
            </span>
            <select
              className="bg-card border border-border rounded px-2 py-1 text-foreground"
              value={selectedProject?.id ?? ''}
              onChange={(event) => setLocalFocusedProjectId(event.target.value || null)}
            >
              {availableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
          <div className="text-muted-foreground mb-0.5">
            {translate('debug.inspector.effectiveProject', 'Effective project')}
          </div>
          <div className="font-mono text-foreground truncate">
            {effectiveExecutionContext.projectName || effectiveExecutionContext.projectId || translate('debug.inspector.none', '(none)')}
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
          <div className="text-muted-foreground mb-0.5">
            {translate('debug.inspector.effectiveExecutionRoot', 'Effective execution root')}
          </div>
          <div className="font-mono text-foreground truncate">
            {effectiveExecutionContext.workspacePath || translate('debug.inspector.none', '(none)')}
          </div>
        </div>

        {effectiveExecutionContext.projectMounts.length > 0 && (
          <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
            <div className="text-muted-foreground mb-1">
              {translate('debug.inspector.virtualMounts', 'Virtual mounts')}
            </div>
            <div className="space-y-1">
              {effectiveExecutionContext.projectMounts.map((mount) => (
                <div key={mount.projectId} className="rounded bg-card px-2 py-1">
                  <div className="font-mono text-foreground">
                    {mount.mountName}/
                    <span className="text-muted-foreground">{' -> '}{mount.projectId}</span>
                  </div>
                  <div className="text-muted-foreground truncate">{mount.displayName}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
          <div className="text-muted-foreground mb-0.5">
            {translate('debug.inspector.backendDefaultRoot', 'Backend default root')}
          </div>
          <div className="font-mono text-foreground truncate">{backendWorkspaceRoot}</div>
        </div>

        {visibleTerminalSessions.length > 0 && (
          <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
            <div className="text-muted-foreground mb-1">
              {translate('debug.inspector.terminalSessions', 'Terminal sessions')}
            </div>
            <div className="space-y-1">
              {visibleTerminalSessions.map((session) => (
                <div key={session.id} className="rounded bg-card px-2 py-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-foreground truncate">
                      {session.mount_name}/
                    </div>
                    <div className="text-muted-foreground">{session.status}</div>
                  </div>
                  <div className="text-muted-foreground truncate">
                    {session.project_name} ({session.project_id})
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground truncate">
                    {session.cwd}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {effectiveExecutionContext.workspacePath &&
          backendWorkspaceRoot !== '(unknown)' &&
          backendWorkspaceRoot !== '(browser)' &&
          backendWorkspaceRoot !== '(error)' &&
          backendWorkspaceRoot !== effectiveExecutionContext.workspacePath && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
              {translate(
                'debug.inspector.toolExecutionUsesEffectiveRoot',
                'Tool execution is using the effective execution root above, not the backend default root.'
              )}
            </div>
          )}

        {chatLastError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-400 flex items-start gap-1.5">
            <Icon name="alert-circle" size={12} className="mt-0.5" />
            <span>{chatLastError}</span>
          </div>
        )}
      </div>

      <div ref={eventsContainerRef} className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {visibleDebugEvents.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center px-4">
            <div>
              <Icon name="search" size={28} className="text-muted-foreground/60 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {translate('debug.inspector.noToolEvents', 'No tool debug events yet.')}
              </p>
              <p className="text-xs text-muted-foreground/80 mt-1">
                {translate('debug.inspector.runPromptToPopulate', 'Run a prompt that triggers tools to populate this panel.')}
              </p>
            </div>
          </div>
        ) : (
          visibleDebugEvents.map((event) => (
            <div
              key={event.id}
              className={cn(
                'rounded-md border px-2.5 py-2 text-xs',
                event.type === 'tool' && 'border-blue-500/30 bg-blue-500/5',
                event.type === 'tool_done' && 'border-emerald-500/30 bg-emerald-500/5',
                event.type === 'error' && 'border-red-500/30 bg-red-500/5'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Icon
                    name={
                      event.type === 'tool'
                        ? 'tool'
                        : event.type === 'tool_done'
                          ? 'check-circle'
                          : 'alert-circle'
                    }
                    size={12}
                    className={cn(
                      event.type === 'tool' && 'text-blue-400',
                      event.type === 'tool_done' && 'text-emerald-400',
                      event.type === 'error' && 'text-red-400'
                    )}
                  />
                  <span className="font-medium text-foreground truncate">
                    {event.type === 'tool' &&
                      translate('debug.inspector.toolEvent', 'TOOL {{tool}}', { tool: event.tool || '' })}
                    {event.type === 'tool_done' &&
                      translate('debug.inspector.doneEvent', 'DONE {{tool}}', { tool: event.tool || '' })}
                    {event.type === 'error' &&
                      translate('debug.inspector.errorEvent', 'ERROR')}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {getRelativeTime(event.timestamp, translate('common.now', 'now'))}
                </span>
              </div>
              <div className="mt-1 text-muted-foreground font-mono break-words">{event.details}</div>
            </div>
          ))
        )}

        {debugEvents.length > MAX_VISIBLE_EVENTS && (
          <div className="text-[11px] text-muted-foreground text-center py-2">
            {translate('debug.inspector.showingLatestEvents', 'Sliding window enabled: showing latest {{count}} events.', {
              count: MAX_VISIBLE_EVENTS,
            })}
          </div>
        )}
      </div>
    </aside>
  );
};

export default DebugInspector;
