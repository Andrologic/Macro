import { useAppStore } from '../stores/useAppStore';
import { useConversationGoalStore } from '../stores/useConversationGoalStore';
import { useChatStore } from '../stores/useChatStore';
import {
  listConversationGoalAuditArtifacts as listArtifacts,
  readGoalAuditArtifact as readArtifact,
  saveGoalAuditArtifact as saveArtifact,
  type GoalAuditArtifact,
  type GoalArtifactEnvironment,
} from '../services/conversationGoalAudit/goalArtifacts';

const environment: GoalArtifactEnvironment = {
  getAppState: () => useAppStore.getState(),
  readMessages: (id) => useChatStore.getState().getConversationMessages(id),
};

export type { GoalAuditArtifact };
export const listConversationGoalAuditArtifacts = (
  projectId: string, conversationId: string, currentGoalId?: string | null,
): Promise<GoalAuditArtifact[]> => listArtifacts(projectId, conversationId, currentGoalId, environment);
export const readGoalAuditArtifact = (artifact: GoalAuditArtifact): Promise<string> =>
  readArtifact(artifact, environment);
export const saveGoalAuditArtifact = async (input: Parameters<typeof saveArtifact>[0]): Promise<GoalAuditArtifact> => {
  const artifact = await saveArtifact(input, environment);
  useConversationGoalStore.getState().markArtifactSaved(input.conversationId);
  return artifact;
};
