import type { CatalogedImplementTask } from './implementTaskCatalog';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';
import {
  flushMacroMetadata,
  recordMacroMetadataMutation,
} from './macroMetadataCoordinator';
import { resolveProjectExecutionMode } from './projectExecutionMode';
import { filterNonWslProjectPaths } from './wslPaths';

const METADATA_WORKSPACE_SCOPE: tauriIpc.WorkspaceScope = 'metadata';

type MetadataWorkspaceTarget = {
  workspacePath: string;
  workspaceScope: tauriIpc.WorkspaceScope;
};

const normalizeBranchName = (value?: string | null): string =>
  value?.trim().replace(/\\/g, '/').replace(/^refs\/heads\//, '').replace(/^\/+/, '').replace(/\/+$/, '') ||
  'develop';

const sanitizeId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `manual-feature-${Date.now()}`;

const toCanonicalMetadataRoot = (task: Pick<CatalogedImplementTask, 'id'>): string =>
  `manual-features/${sanitizeId(task.id)}`;

const toLegacyMetadataRoot = (
  task: Pick<CatalogedImplementTask, 'id' | 'base_branch'>
): string =>
  `branches/${normalizeBranchName(task.base_branch)}/manual-features/${sanitizeId(task.id)}`;

const unique = (items: Array<string | null | undefined>): string[] =>
  Array.from(
    new Set(
      items
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );

const getTaskProjectIds = (
  task: Pick<CatalogedImplementTask, 'project_id' | 'project_ids' | 'execution_targets'>
): string[] =>
  unique([
    ...(task.project_ids || []),
    ...(task.execution_targets || []).map((target) => target.projectId),
    task.project_id,
  ]);

const resolveMetadataWorkspaceTargets = (
  task: Pick<CatalogedImplementTask, 'project_id' | 'project_ids' | 'execution_targets'>
): MetadataWorkspaceTarget[] => {
  const appState = useAppStore.getState();
  const projectIds = getTaskProjectIds(task);
  const targets = projectIds.flatMap((projectId): MetadataWorkspaceTarget[] => {
    const project = appState.getProjectById(projectId);
    if (!project || filterNonWslProjectPaths([project.path]).length === 0) {
      return [];
    }
    const executionTarget = task.execution_targets?.find(
      (candidate) => candidate.projectId === projectId
    );
    const mode = resolveProjectExecutionMode({ project, target: executionTarget }).mode;
    if (mode !== 'git' && mode !== 'direct') {
      return [];
    }
    return [{
      workspacePath: project.path,
      workspaceScope: mode === 'direct' ? 'direct' : METADATA_WORKSPACE_SCOPE,
    }];
  });
  return Array.from(new Map(
    targets.map((target) => [`${target.workspaceScope}:${target.workspacePath}`, target])
  ).values());
};

const deleteMetadataRootIfPresent = async (
  metadataRoot: string,
  target: MetadataWorkspaceTarget
): Promise<void> => {
  try {
    const exists = await tauriIpc.fsExists(metadataRoot, {
      workspaceScope: target.workspaceScope,
      workspacePath: target.workspacePath,
    });
    if (!exists) {
      return;
    }
  } catch {
    return;
  }

  try {
    await tauriIpc.fsDelete({
      path: metadataRoot,
      recursive: true,
      workspaceScope: target.workspaceScope,
      workspacePath: target.workspacePath,
    });
  } catch {
    // Treat missing or concurrently removed legacy metadata as already cleaned up.
  }
};

const buildTranscriptJsonl = async (conversationId: string | null): Promise<string> => {
  if (!conversationId) return '';
  const messages = await tauriIpc.listMessages(conversationId);
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) =>
      JSON.stringify({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.created_at,
      })
    )
    .join('\n');
};

const buildMetadataJson = (
  task: Pick<
    CatalogedImplementTask,
    | 'id'
    | 'title'
    | 'description'
    | 'status'
    | 'draft'
    | 'feature_slug'
    | 'task_kind'
    | 'branch_name'
    | 'base_branch'
    | 'conversation_id'
    | 'project_id'
    | 'project_ids'
    | 'execution_targets'
  >
): string => {
  return JSON.stringify(
    {
      schemaVersion: 1,
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      draft: task.draft,
      featureSlug: task.feature_slug ?? null,
      taskKind: task.task_kind ?? null,
      branchName: task.branch_name || null,
      baseBranch: normalizeBranchName(task.base_branch),
      conversationId: task.conversation_id ?? null,
      projectIds: getTaskProjectIds(task),
      executionTargets: (task.execution_targets || []).map((target) => ({
        projectId: target.projectId,
        branchName: target.branchName,
        targetBranchName: target.targetBranchName ?? null,
        executionMode: target.executionMode ?? null,
        executionKind: target.executionKind ?? null,
        checkpointId: target.checkpointId ?? null,
        baseCommitHash: target.baseCommitHash ?? null,
        worktreeKey: target.worktreeKey,
        repoPath: target.repoPath ?? null,
      })),
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );
};

const buildMetadataMarkdown = (
  task: Pick<
    CatalogedImplementTask,
    | 'id'
    | 'title'
    | 'description'
    | 'status'
    | 'draft'
    | 'feature_slug'
    | 'task_kind'
    | 'branch_name'
    | 'base_branch'
    | 'conversation_id'
    | 'project_id'
    | 'project_ids'
    | 'execution_targets'
  >
): string => {
  const projectIds = getTaskProjectIds(task);
  const executionTargets = task.execution_targets || [];
  const lines = [
    `# Standalone Task: ${task.title}`,
    '',
    `- Task ID: ${task.id}`,
    `- Task Kind: ${task.task_kind || 'pending classification'}`,
    `- Status: ${task.draft ? 'Draft' : task.status}`,
    `- Base Branch (legacy snapshot): ${normalizeBranchName(task.base_branch)}`,
    `- Task Branch: ${task.branch_name || 'Not created yet'}`,
    `- Task Slug: ${task.feature_slug || 'pending'}`,
    `- Conversation ID: ${task.conversation_id || 'none'}`,
    `- Projects: ${projectIds.join(', ') || 'none'}`,
    '',
    '## Description',
    task.description || 'No description provided.',
  ];

  lines.push('', '## Execution Targets');
  if (executionTargets.length === 0) {
    lines.push('- None');
  } else {
    for (const target of executionTargets) {
      const targetLabel = target.targetBranchName?.trim() || normalizeBranchName(task.base_branch);
      const repoPathLabel = target.repoPath ? ` (${target.repoPath})` : '';
      lines.push(
        `- ${target.projectId}${repoPathLabel}: ${target.branchName} -> ${targetLabel}`
      );
    }
  }

  return lines.join('\n');
};

const commitMetadataTargets = async (workspacePaths: string[], message: string): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || workspacePaths.length === 0) {
    return;
  }

  await flushMacroMetadata({
    trigger: 'explicit_checkpoint',
    workspacePaths,
    message,
  });
};

export const commitManualFeatureMetadata = async (
  task: Pick<
    CatalogedImplementTask,
    'id' | 'base_branch' | 'project_id' | 'project_ids' | 'execution_targets' | 'standalone_kind'
  >,
  message?: string
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || task.standalone_kind !== 'manual_feature') {
    return;
  }

  const workspaceTargets = resolveMetadataWorkspaceTargets(task);
  if (workspaceTargets.length === 0) {
    return;
  }

  await commitMetadataTargets(
    workspaceTargets
      .filter((target) => target.workspaceScope === METADATA_WORKSPACE_SCOPE)
      .map((target) => target.workspacePath),
    message?.trim().length ? message.trim() : 'chore(@macro): update task metadata'
  );
};

export const syncManualFeatureMetadataFromTask = async (
  task: Pick<
    CatalogedImplementTask,
    | 'id'
    | 'title'
    | 'description'
    | 'status'
    | 'draft'
    | 'feature_slug'
    | 'branch_name'
    | 'base_branch'
    | 'conversation_id'
    | 'project_id'
    | 'project_ids'
    | 'execution_targets'
    | 'task_kind'
    | 'standalone_kind'
  >
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || task.standalone_kind !== 'manual_feature') {
    return;
  }

  const workspaceTargets = resolveMetadataWorkspaceTargets(task);
  if (workspaceTargets.length === 0) {
    return;
  }

  const metadataRoot = toCanonicalMetadataRoot(task);
  const legacyMetadataRoot = toLegacyMetadataRoot(task);
  const metadataJson = buildMetadataJson(task);
  const metadataMarkdown = buildMetadataMarkdown(task);
  const transcriptJsonl = await buildTranscriptJsonl(task.conversation_id ?? null);

  await Promise.all(
    workspaceTargets.map(async (target) => {
      await tauriIpc.fsWriteFile({
        path: `${metadataRoot}/feature.json`,
        content: metadataJson,
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: target.workspaceScope,
        workspacePath: target.workspacePath,
      });
      await tauriIpc.fsWriteFile({
        path: `${metadataRoot}/feature.md`,
        content: metadataMarkdown,
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: target.workspaceScope,
        workspacePath: target.workspacePath,
      });
      await tauriIpc.fsWriteFile({
        path: `${metadataRoot}/chat.jsonl`,
        content: transcriptJsonl,
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: target.workspaceScope,
        workspacePath: target.workspacePath,
      });

      if (legacyMetadataRoot !== metadataRoot) {
        await deleteMetadataRootIfPresent(legacyMetadataRoot, target);
      }

      recordMacroMetadataMutation({
        workspacePath: target.workspacePath,
        kind: 'manual_feature',
        entityId: task.id,
        label: task.id,
        importance: 'light',
      });
    })
  );
  await commitMetadataTargets(
    workspaceTargets
      .filter((target) => target.workspaceScope === METADATA_WORKSPACE_SCOPE)
      .map((target) => target.workspacePath),
    `chore(@macro): update manual feature ${task.id}`,
  );
};

export const removeManualFeatureMetadata = async (
  task: Pick<
    CatalogedImplementTask,
    'id' | 'base_branch' | 'project_id' | 'project_ids' | 'execution_targets' | 'standalone_kind'
  >
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || task.standalone_kind !== 'manual_feature') {
    return;
  }

  const workspaceTargets = resolveMetadataWorkspaceTargets(task);
  if (workspaceTargets.length === 0) {
    return;
  }

  const metadataRoots = Array.from(
    new Set([toCanonicalMetadataRoot(task), toLegacyMetadataRoot(task)])
  );
  await Promise.all(
    workspaceTargets.map(async (target) => {
      await Promise.all(
        metadataRoots.map((metadataRoot) =>
          deleteMetadataRootIfPresent(metadataRoot, target)
        )
      );
      recordMacroMetadataMutation({
        workspacePath: target.workspacePath,
        kind: 'manual_feature',
        entityId: task.id,
        label: task.id,
        importance: 'light',
      });
    })
  );
  await commitMetadataTargets(
    workspaceTargets
      .filter((target) => target.workspaceScope === METADATA_WORKSPACE_SCOPE)
      .map((target) => target.workspacePath),
    `chore(@macro): delete manual feature ${task.id}`,
  );
};
