import type { useAppStore } from '../../stores/useAppStore';
import type { ChatMessage } from '../../types';
import { getGitFlowBaseBranch } from '../architectPlanService';
import { sanitizeId } from '../../domains/plans/artifactContracts';
import { readArtifactFileSnapshot, persistArtifactMutation, type ArtifactFileMutation } from '../architectPlanArtifactPersistence';
import { resolveArchitectPlanServiceDependencies } from '../architectPlanReadContext';
import { recoverArchitectPlanReplicaMutationsUnlocked, resolveReplicaWorkspaceKey, withReplicaTransactionLock } from '../architectPlanMutationPersistence';
import { buildValidProjectRegistrySnapshot } from '../validProjectRegistry';
import * as tauriIpc from '../tauriIpc';
import type { GoalAuditResult } from './types';

const branch = (): string => getGitFlowBaseBranch();
export interface GoalArtifactEnvironment {
  getAppState(): ReturnType<typeof useAppStore.getState>;
  readMessages(conversationId: string): ChatMessage[];
}
const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export interface GoalAuditArtifact {
  id: string;
  conversationId: string;
  goalId: string;
  goalRevision: number;
  executorTurnId: string;
  runId: string;
  messageId: string;
  projectId: string;
  kind: 'goal_audit';
  title: string;
  summary: string;
  contentType: 'json';
  contentHash: string;
  path: string;
  createdAt: string;
  review: { status: GoalAuditResult['status']; verdict: string | null };
}

interface GoalArtifactIndex {
  schemaVersion: 1;
  conversationId: string;
  goalId: string;
  artifacts: GoalAuditArtifact[];
}

const root = (conversationId: string, goalId: string): string =>
  `branches/${branch()}/goals/${sanitizeId(conversationId)}/${sanitizeId(goalId)}/artifacts`;

const targetFor = (projectId: string, environment: GoalArtifactEnvironment) => {
  const project = environment.getAppState().getProjectById(projectId);
  if (!project?.path) throw new Error('The goal project is unavailable for audit artifacts.');
  return { workspacePath: project.path, workspaceScope: 'metadata' as const };
};

const withArtifactRecovery = async <T>(environment: GoalArtifactEnvironment, operation: (workspaceKey: string) => Promise<T>): Promise<T> => {
  if (!tauriIpc.isTauriAvailable()) throw new Error('Goal audit artifacts require the native runtime.');
  const app = environment.getAppState();
  const deps = resolveArchitectPlanServiceDependencies({ getAppState: () => app });
  const registry = buildValidProjectRegistrySnapshot(app);
  const workspaceKey = await resolveReplicaWorkspaceKey(deps, registry);
  return withReplicaTransactionLock(workspaceKey, async () => {
    await recoverArchitectPlanReplicaMutationsUnlocked(deps, registry, workspaceKey);
    return operation(workspaceKey);
  });
};

const parseIndex = (content: string | null, projectId: string, conversationId: string, goalId: string): GoalArtifactIndex => {
  if (!content) return { schemaVersion: 1, conversationId, goalId, artifacts: [] };
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid goal artifact index.');
  const index = value as GoalArtifactIndex;
  if (index.schemaVersion !== 1 || index.conversationId !== conversationId || index.goalId !== goalId ||
      !Array.isArray(index.artifacts) || index.artifacts.some((item) => !item ||
        item.goalId !== goalId || item.conversationId !== conversationId || item.projectId !== projectId ||
        item.kind !== 'goal_audit' || typeof item.id !== 'string' || item.id !== sanitizeId(item.id) ||
        item.path !== `${root(conversationId, goalId)}/${item.id}.json` ||
        !Number.isInteger(item.goalRevision) || item.goalRevision < 1 ||
        typeof item.runId !== 'string' || !item.runId ||
        typeof item.executorTurnId !== 'string' || !item.executorTurnId ||
        typeof item.contentHash !== 'string' || !/^[0-9a-f]{8}$/.test(item.contentHash))) {
    throw new Error('Goal artifact index has a different owner or schema.');
  }
  return index;
};

export const listGoalAuditArtifacts = async (projectId: string, conversationId: string, goalId: string, environment: GoalArtifactEnvironment): Promise<GoalAuditArtifact[]> => {
  const target = targetFor(projectId, environment);
  return withArtifactRecovery(environment, async () => {
    const snapshot = await readArtifactFileSnapshot({ ...target, path: `${root(conversationId, goalId)}/index.json` });
    return parseIndex(snapshot.content, projectId, conversationId, goalId).artifacts;
  });
};

/** Native applied audits are the recovery source if an artifact write failed after the verdict commit. */
export const listConversationGoalAuditArtifacts = async (
  projectId: string, conversationId: string, currentGoalId: string | null | undefined,
  environment: GoalArtifactEnvironment,
): Promise<GoalAuditArtifact[]> => {
  const audits = await tauriIpc.listConversationGoalAudits(conversationId);
  const goalIds = new Set(audits.map((audit) => audit.goalId));
  if (currentGoalId) goalIds.add(currentGoalId);
  const byGoal = new Map<string, GoalAuditArtifact[]>();
  for (const goalId of goalIds) byGoal.set(goalId, await listGoalAuditArtifacts(projectId, conversationId, goalId, environment));
  for (const audit of audits) {
    if (audit.status !== 'applied' || !audit.verdict) continue;
    const existing = byGoal.get(audit.goalId)?.find((item) => item.id === audit.auditId);
    if (existing?.review.status === 'applied') {
      const file = await readArtifactFileSnapshot({ ...targetFor(projectId, environment), path: existing.path });
      if (file.content !== null) {
        await readGoalAuditArtifact(existing, environment);
        continue;
      }
    }
    const message = environment.readMessages(conversationId)
      .find((item) => item.role === 'assistant' && item.turn_id === audit.executorTurnId);
    await saveGoalAuditArtifact({
      projectId, conversationId, goalId: audit.goalId, goalRevision: audit.goalRevision,
      executorTurnId: audit.executorTurnId, runId: audit.currentRunId, auditId: audit.auditId,
      messageId: message?.id ?? '', result: { status: 'applied', runId: audit.currentRunId, verdict: audit.verdict },
    }, environment);
    byGoal.set(audit.goalId, await listGoalAuditArtifacts(projectId, conversationId, audit.goalId, environment));
  }
  return Array.from(byGoal.values()).flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
};

const readGoalAuditArtifactUnlocked = async (artifact: GoalAuditArtifact, environment: GoalArtifactEnvironment): Promise<string> => {
  const target = targetFor(artifact.projectId, environment);
  const snapshot = await readArtifactFileSnapshot({ ...target, path: artifact.path });
  if (snapshot.content === null) throw new Error('Goal audit artifact is missing.');
  const parsed: unknown = JSON.parse(snapshot.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Goal audit artifact is invalid.');
  const record = parsed as { artifact?: GoalAuditArtifact; result?: GoalAuditResult };
  if (!record.artifact || record.artifact.id !== artifact.id || record.artifact.goalId !== artifact.goalId ||
      record.artifact.conversationId !== artifact.conversationId || record.artifact.runId !== artifact.runId ||
      record.artifact.executorTurnId !== artifact.executorTurnId || record.artifact.projectId !== artifact.projectId ||
      record.artifact.path !== artifact.path || record.result?.status !== artifact.review.status ||
      hashString(JSON.stringify(record.result)) !== artifact.contentHash) {
    throw new Error('Goal audit artifact identity or content changed.');
  }
  return snapshot.content;
};

export const readGoalAuditArtifact = async (artifact: GoalAuditArtifact, environment: GoalArtifactEnvironment): Promise<string> =>
  withArtifactRecovery(environment, () => readGoalAuditArtifactUnlocked(artifact, environment));

export const saveGoalAuditArtifact = async (input: {
  projectId: string;
  conversationId: string;
  goalId: string;
  goalRevision: number;
  executorTurnId: string;
  runId: string;
  auditId: string;
  messageId: string;
  result: GoalAuditResult;
}, environment: GoalArtifactEnvironment): Promise<GoalAuditArtifact> => {
  const target = targetFor(input.projectId, environment);
  return withArtifactRecovery(environment, async (workspaceKey) => {
    const base = root(input.conversationId, input.goalId);
    const indexPath = `${base}/index.json`;
    const beforeIndex = await readArtifactFileSnapshot({ ...target, path: indexPath });
    const index = parseIndex(beforeIndex.content, input.projectId, input.conversationId, input.goalId);
    const id = sanitizeId(input.auditId);
    if (!input.auditId || id !== input.auditId.toLowerCase()) throw new Error('Invalid goal audit artifact identity.');
    const path = `${base}/${id}.json`;
    const existing = index.artifacts.find((item) => item.id === id);
    if (existing) {
      if (existing.runId !== input.runId || existing.executorTurnId !== input.executorTurnId) throw new Error('Goal artifact identity conflict.');
      if (existing.review.status === 'applied' || input.result.status !== 'applied') {
        const file = await readArtifactFileSnapshot({ ...target, path });
        if (file.content !== null) {
          await readGoalAuditArtifactUnlocked(existing, environment);
          return existing;
        }
      }
    }
    const artifact: GoalAuditArtifact = {
      id, conversationId: input.conversationId, goalId: input.goalId,
      goalRevision: input.goalRevision, executorTurnId: input.executorTurnId,
      runId: input.runId, messageId: input.messageId, projectId: input.projectId,
      kind: 'goal_audit', title: 'Goal review',
      summary: input.result.status === 'applied' ? input.result.verdict.summary : input.result.status,
      contentType: 'json', contentHash: hashString(JSON.stringify(input.result)), path,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      review: { status: input.result.status, verdict: input.result.status === 'applied' ? input.result.verdict.verdict : null },
    };
    const content = `${JSON.stringify({ artifact, result: input.result }, null, 2)}\n`;
    const beforeContent = await readArtifactFileSnapshot({ ...target, path });
    if (existing && beforeContent.content !== null) await readGoalAuditArtifactUnlocked(existing, environment);
    else if (beforeContent.content !== null) throw new Error('Goal artifact file already exists without an index entry.');
    const nextIndex: GoalArtifactIndex = { ...index, artifacts: existing
      ? index.artifacts.map((item) => item.id === id ? artifact : item) : [...index.artifacts, artifact] };
    const files: ArtifactFileMutation[] = [
      { ...target, path, before: beforeContent.content, after: content },
      { ...target, path: indexPath, before: beforeIndex.content, after: `${JSON.stringify(nextIndex, null, 2)}\n` },
    ];
    await persistArtifactMutation({
      branchName: branch(),
      planId: sanitizeId(input.goalId),
      goalArtifactScope: { conversationId: sanitizeId(input.conversationId), goalId: sanitizeId(input.goalId) },
      workspaceKey,
      files,
    });
    return artifact;
  });
};
