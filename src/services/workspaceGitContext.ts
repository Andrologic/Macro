import type { WorkspaceSession } from '../domains/shell/workspace';
import { workspaceDefinitions } from '../domains/shell/workspace';
import { resolveFooterGitContext, type FooterGitContext, type ResolveFooterGitContextInput } from './footerGitContext';

export type WorkspaceGitContextInput = Omit<ResolveFooterGitContextInput,
  'mode' | 'selectedTaskId' | 'activeArchitectPlanId' | 'selectedConversationId'>;

/** Resolve the shell's target reference through the existing Git domain resolver. */
export function resolveWorkspaceGitContext(
  session: WorkspaceSession,
  input: WorkspaceGitContextInput,
): FooterGitContext {
  const target = session.executionTarget;
  const mode = session.agentProfile.mode;
  const unavailable = (): FooterGitContext => ({
    contextKey: JSON.stringify(['unavailable-workspace-target', session.id, target]),
    candidates: [], project: null, reason: 'missing_context',
  });
  // No remote Git adapter is installed. A reference must never fall back to a local selection.
  if (target.kind !== 'local') return unavailable();
  const scope = target.scope;
  if (scope.kind !== 'selection' && scope.kind !== workspaceDefinitions[mode].sessionKind) {
    return unavailable();
  }
  return resolveFooterGitContext({
    ...input,
    mode,
    selectedTaskId: scope.kind === 'task' ? scope.id : null,
    activeArchitectPlanId: scope.kind === 'plan' ? scope.id : null,
    selectedConversationId: scope.kind === 'conversation' ? scope.id : null,
    durableFocusProjectId: scope.kind === 'selection' ? scope.projectId : input.durableFocusProjectId,
  });
}
