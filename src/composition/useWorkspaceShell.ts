import { useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { createWorkspaceSession, workspaceDefinitions, type WorkspaceSessionInput, type WorkspaceViewId } from '../domains/shell/workspace';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useWorkspaceSessionsStore } from '../stores/useWorkspaceSessionsStore';
import { resolveWorkspaceView, workspaceViews } from './workspaceViews';

/** Composition reads domain identities. It never copies workflow or transcript state. */
export function useWorkspaceShell() {
  useSyncExternalStore(workspaceViews.subscribe, workspaceViews.getRevision, workspaceViews.getRevision);
  const selection = useAppStore(useShallow((state) => ({
    mode: state.mode, agentType: state.agentType,
    planId: state.activeArchitectPlanId ?? null, taskId: state.selectedTaskId ?? null,
    groupId: state.selectedGroupId ?? null, projectId: state.selectedProjectId ?? null,
  })));
  const conversationId = useChatStore((state) => state.selectedConversationIdsByMode.Chat ?? null);
  const sessions = useWorkspaceSessionsStore((state) => state.sessions);
  const input: WorkspaceSessionInput = { ...selection, conversationId };
  const session = createWorkspaceSession(workspaceDefinitions[selection.mode], input);
  const view = resolveWorkspaceView(session, sessions[session.id]?.selectedViewId);
  const navigation = Object.values(workspaceDefinitions).flatMap((definition) => {
    const candidateSession = createWorkspaceSession(definition, input);
    return workspaceViews.list(candidateSession)
      .filter((candidate) => candidate.workspaceId === definition.id)
      .map((candidate) => ({ view: candidate, session: candidateSession, mode: definition.semanticMode }));
  });


  return { session, view, navigation, selectView: selectWorkspaceView };
}

/** Resolve again at dispatch time so a stale UI closure cannot select another session. */
export function selectWorkspaceView(id: WorkspaceViewId): void {
  const contribution = workspaceViews.all().find((entry) => entry.id === id);
  const definition = Object.values(workspaceDefinitions).find((entry) => entry.id === contribution?.workspaceId);
  if (!definition) return;
  const readSession = () => {
    const state = useAppStore.getState();
    return createWorkspaceSession(definition, {
      agentType: state.agentType, planId: state.activeArchitectPlanId ?? null,
      taskId: state.selectedTaskId ?? null, groupId: state.selectedGroupId ?? null,
      projectId: state.selectedProjectId ?? null,
      conversationId: useChatStore.getState().selectedConversationIdsByMode.Chat ?? null,
    });
  };
  if (!workspaceViews.get(id, readSession())) return;
  if (definition.semanticMode !== useAppStore.getState().mode) {
    useAppStore.getState().setMode(definition.semanticMode);
  }
  const session = readSession();
  if (workspaceViews.get(id, session)?.workspaceId !== definition.id) return;
  useWorkspaceSessionsStore.getState().selectView(session, id);
}
