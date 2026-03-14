import React, { useEffect, useMemo, useRef } from 'react';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { useProviderStore } from '../../stores/useProviderStore';
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

const getRelativeTime = (timestamp: string): string => {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return '';

  const deltaSeconds = Math.floor((Date.now() - parsed) / 1000);
  if (deltaSeconds < 5) return 'now';
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
  const [backendWorkspaceRoot, setBackendWorkspaceRoot] = React.useState<string>('(unknown)');
  const [localFocusedProjectId, setLocalFocusedProjectId] = React.useState<string | null>(null);
  const [projectRegistryDiagnostics, setProjectRegistryDiagnostics] =
    React.useState<tauriIpc.ProjectRegistryDiagnosticsDto | null>(null);

  const selectedProviderId = useProviderStore((state) => state.selectedProviderId);
  const selectedModelId = useProviderStore((state) => state.selectedModelId);

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

  useEffect(() => {
    let cancelled = false;

    const loadRuntimeDiagnostics = async () => {
      if (!tauriIpc.isTauriAvailable()) {
        if (!cancelled) {
          setBackendWorkspaceRoot('(browser)');
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
          setBackendWorkspaceRoot(root || '(unknown)');
          setProjectRegistryDiagnostics(diagnostics);
        }
      } catch {
        if (!cancelled) {
          setBackendWorkspaceRoot('(error)');
          setProjectRegistryDiagnostics(null);
        }
      }
    };

    void loadRuntimeDiagnostics();

    return () => {
      cancelled = true;
    };
  }, [selectedProject?.path, selectedConversationId, mode]);

  useEffect(() => {
    if (!eventsContainerRef.current) return;
    eventsContainerRef.current.scrollTop = 0;
  }, [visibleDebugEvents.length]);

  const statePills = [
    { label: 'Mode', value: mode, icon: 'terminal' as const },
    { label: 'Provider', value: selectedProviderId || 'none', icon: 'cpu' as const },
    { label: 'Model', value: selectedModelId || 'none', icon: 'sparkles' as const },
    { label: 'Stream', value: isStreaming ? 'active' : isLoading ? 'loading' : 'idle', icon: 'loader' as const },
  ];

  return (
    <aside className={cn('h-full w-full bg-card border-l border-border flex flex-col', className)}>
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="terminal" size={16} className="text-primary" />
          Debug Inspector
        </h1>
        <span className="text-xs text-muted-foreground">
          {visibleDebugEvents.length}/{debugEvents.length} events
        </span>
      </div>

      <div className="border-b border-border p-3 space-y-2">
        <div className="text-xs text-muted-foreground">Runtime</div>
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
          <div className="text-muted-foreground mb-0.5">Selected project root</div>
          <div className="font-mono text-foreground truncate">
            {selectedProject?.path || '(none)'}
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
          <div className="text-muted-foreground mb-1">Project registry</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded bg-card px-2 py-1">
              <div className="text-muted-foreground">Frontend groups</div>
              <div className="text-foreground font-medium">{projectGroups.length}</div>
            </div>
            <div className="rounded bg-card px-2 py-1">
              <div className="text-muted-foreground">Frontend projects</div>
              <div className="text-foreground font-medium">
                {projectGroups.reduce((total, group) => total + group.projects.length, 0)}
              </div>
            </div>
            <div className="rounded bg-card px-2 py-1">
              <div className="text-muted-foreground">Backend raw</div>
              <div className="text-foreground font-medium">
                {projectRegistryDiagnostics
                  ? `${projectRegistryDiagnostics.rawGroupCount}/${projectRegistryDiagnostics.rawProjectCount}`
                  : '(n/a)'}
              </div>
            </div>
            <div className="rounded bg-card px-2 py-1">
              <div className="text-muted-foreground">Backend sanitized</div>
              <div className="text-foreground font-medium">
                {projectRegistryDiagnostics
                  ? `${projectRegistryDiagnostics.sanitizedGroupCount}/${projectRegistryDiagnostics.sanitizedProjectCount}`
                  : '(n/a)'}
              </div>
            </div>
          </div>
          {projectRegistryDiagnostics && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              duplicates repaired: {projectRegistryDiagnostics.repairReport.duplicate_paths_removed},
              empty groups: {projectRegistryDiagnostics.repairReport.empty_groups_removed},
              dead nodes: {projectRegistryDiagnostics.repairReport.plan_nodes_removed},
              dead branches: {projectRegistryDiagnostics.repairReport.predicted_branches_removed}
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
            <span className="text-muted-foreground">Debug repo focus</span>
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
          <div className="text-muted-foreground mb-0.5">Effective project</div>
          <div className="font-mono text-foreground truncate">
            {effectiveExecutionContext.projectName || effectiveExecutionContext.projectId || '(none)'}
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
          <div className="text-muted-foreground mb-0.5">Effective execution root</div>
          <div className="font-mono text-foreground truncate">
            {effectiveExecutionContext.workspacePath || '(none)'}
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
          <div className="text-muted-foreground mb-0.5">Backend default root</div>
          <div className="font-mono text-foreground truncate">{backendWorkspaceRoot}</div>
        </div>

        {effectiveExecutionContext.workspacePath &&
          backendWorkspaceRoot !== '(unknown)' &&
          backendWorkspaceRoot !== '(browser)' &&
          backendWorkspaceRoot !== '(error)' &&
          backendWorkspaceRoot !== effectiveExecutionContext.workspacePath && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
              Tool execution is using the effective execution root above, not the backend default root.
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
              <p className="text-sm text-muted-foreground">No tool debug events yet.</p>
              <p className="text-xs text-muted-foreground/80 mt-1">Run a prompt that triggers tools to populate this panel.</p>
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
                    {event.type === 'tool' && `TOOL ${event.tool || ''}`}
                    {event.type === 'tool_done' && `DONE ${event.tool || ''}`}
                    {event.type === 'error' && 'ERROR'}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {getRelativeTime(event.timestamp)}
                </span>
              </div>
              <div className="mt-1 text-muted-foreground font-mono break-words">{event.details}</div>
            </div>
          ))
        )}

        {debugEvents.length > MAX_VISIBLE_EVENTS && (
          <div className="text-[11px] text-muted-foreground text-center py-2">
            Sliding window enabled: showing latest {MAX_VISIBLE_EVENTS} events.
          </div>
        )}
      </div>
    </aside>
  );
};

export default DebugInspector;
