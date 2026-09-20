import type { AgentType, AppMode } from '../../types';

export type WorkspaceId = `workspace.${string}`;
export type WorkspaceViewId = `view.${string}`;
export type SessionKind = 'plan' | 'task' | 'conversation';

/** Static product definition. View contributions cannot introduce agent modes. */
export interface WorkspaceDefinition {
  readonly id: WorkspaceId;
  readonly semanticMode: AppMode;
  readonly defaultViewId: WorkspaceViewId;
  readonly sessionKind: SessionKind;
}

export interface WorkspaceAgentProfile {
  readonly mode: AppMode;
  readonly agentType: AgentType;
}

/** References are resolved by their domain; the shell does not choose repository paths. */
export type WorkspaceExecutionTarget =
  | { readonly kind: 'local'; readonly scope: WorkspaceSessionScope }
  | { readonly kind: 'remote-reference'; readonly targetId: string };

export type WorkspaceSessionScope =
  | { readonly kind: SessionKind; readonly id: string }
  | { readonly kind: 'selection'; readonly groupId: string | null; readonly projectId: string | null };

export interface WorkspaceSession {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly scope: WorkspaceSessionScope;
  readonly agentProfile: WorkspaceAgentProfile;
  readonly executionTarget: WorkspaceExecutionTarget;
}

export interface WorkspaceSessionInput {
  readonly agentType: AgentType;
  readonly planId: string | null;
  readonly taskId: string | null;
  readonly conversationId: string | null;
  readonly groupId: string | null;
  readonly projectId: string | null;
}

export const createWorkspaceSession = (
  definition: WorkspaceDefinition,
  input: WorkspaceSessionInput,
): WorkspaceSession => {
  const identities: Record<SessionKind, string | null> = {
    plan: input.planId, task: input.taskId, conversation: input.conversationId,
  };
  const entityId = identities[definition.sessionKind];
  // A free Chat session never acquires the selected project implicitly.
  const scope: WorkspaceSessionScope = entityId
    ? { kind: definition.sessionKind, id: entityId }
    : { kind: 'selection', groupId: definition.sessionKind === 'conversation' ? null : input.groupId,
      projectId: definition.sessionKind === 'conversation' ? null : input.projectId };
  return {
    id: JSON.stringify([definition.id, scope]),
    workspaceId: definition.id,
    scope,
    agentProfile: { mode: definition.semanticMode, agentType: input.agentType },
    executionTarget: { kind: 'local', scope },
  };
};

export const workspaceDefinitions: Readonly<Record<AppMode, WorkspaceDefinition>> = {
  Architect: { id: 'workspace.architect', semanticMode: 'Architect', defaultViewId: 'view.architect', sessionKind: 'plan' },
  Implement: { id: 'workspace.implement', semanticMode: 'Implement', defaultViewId: 'view.implement', sessionKind: 'task' },
  Chat: { id: 'workspace.chat', semanticMode: 'Chat', defaultViewId: 'view.chat', sessionKind: 'conversation' },
};

export const isWorkspaceMode = (value: unknown): value is AppMode =>
  typeof value === 'string' && Object.hasOwn(workspaceDefinitions, value);
