import type { CatalogedImplementTask } from './implementTaskCatalog';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';
import {
  flushMacroMetadata,
  recordMacroMetadataMutation,
} from './macroMetadataCoordinator';

const METADATA_WORKSPACE_SCOPE: tauriIpc.WorkspaceScope = 'metadata';

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

const resolveMetadataWorkspacePaths = (
  task: Pick<CatalogedImplementTask, 'project_id' | 'project_ids' | 'execution_targets'>
): string[] => {
  const appState = useAppStore.getState();
  const projectIds = getTaskProjectIds(task);
  return unique([
    ...(task.execution_targets || []).map((target) => target.repoPath ?? null),
    ...projectIds.map((projectId) => appState.getProjectById(projectId)?.path ?? null),
  ]);
};

const deleteMetadataRootIfPresent = async (
  metadataRoot: string,
  workspacePath: string
): Promise<void> => {
  try {
    const exists = await tauriIpc.fsExists(metadataRoot, {
      workspaceScope: METADATA_WORKSPACE_SCOPE,
      workspacePath,
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
      workspaceScope: METADATA_WORKSPACE_SCOPE,
      workspacePath,
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
      branchName: task.branch_name || null,
      baseBranch: normalizeBranchName(task.base_branch),
      conversationId: task.conversation_id ?? null,
      projectIds: getTaskProjectIds(task),
      executionTargets: (task.execution_targets || []).map((target) => ({
        projectId: target.projectId,
        branchName: target.branchName,
        targetBranchName: target.targetBranchName ?? null,
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
    `# Manual Feature: ${task.title}`,
    '',
    `- Feature ID: ${task.id}`,
    `- Status: ${task.draft ? 'Draft' : task.status}`,
    `- Base Branch (legacy snapshot): ${normalizeBranchName(task.base_branch)}`,
    `- Feature Branch: ${task.branch_name || 'Not created yet'}`,
    `- Feature Slug: ${task.feature_slug || 'pending'}`,
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

  const workspacePaths = resolveMetadataWorkspacePaths(task);
  if (workspacePaths.length === 0) {
    return;
  }

  await commitMetadataTargets(
    workspacePaths,
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
    | 'standalone_kind'
  >
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || task.standalone_kind !== 'manual_feature') {
    return;
  }

  const workspacePaths = resolveMetadataWorkspacePaths(task);
  if (workspacePaths.length === 0) {
    return;
  }

  const metadataRoot = toCanonicalMetadataRoot(task);
  const legacyMetadataRoot = toLegacyMetadataRoot(task);
  const metadataJson = buildMetadataJson(task);
  const metadataMarkdown = buildMetadataMarkdown(task);
  const transcriptJsonl = await buildTranscriptJsonl(task.conversation_id ?? null);

  await Promise.all(
    workspacePaths.map(async (workspacePath) => {
      await tauriIpc.fsWriteFile({
        path: `${metadataRoot}/feature.json`,
        content: metadataJson,
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: METADATA_WORKSPACE_SCOPE,
        workspacePath,
      });
      await tauriIpc.fsWriteFile({
        path: `${metadataRoot}/feature.md`,
        content: metadataMarkdown,
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: METADATA_WORKSPACE_SCOPE,
        workspacePath,
      });
      await tauriIpc.fsWriteFile({
        path: `${metadataRoot}/chat.jsonl`,
        content: transcriptJsonl,
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: METADATA_WORKSPACE_SCOPE,
        workspacePath,
      });

      if (legacyMetadataRoot !== metadataRoot) {
        await deleteMetadataRootIfPresent(legacyMetadataRoot, workspacePath);
      }

      recordMacroMetadataMutation({
        workspacePath,
        kind: 'manual_feature',
        entityId: task.id,
        label: task.id,
        importance: 'light',
      });
    })
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

  const workspacePaths = resolveMetadataWorkspacePaths(task);
  if (workspacePaths.length === 0) {
    return;
  }

  const metadataRoots = Array.from(
    new Set([toCanonicalMetadataRoot(task), toLegacyMetadataRoot(task)])
  );
  await Promise.all(
    workspacePaths.map(async (workspacePath) => {
      await Promise.all(
        metadataRoots.map((metadataRoot) =>
          deleteMetadataRootIfPresent(metadataRoot, workspacePath)
        )
      );
      recordMacroMetadataMutation({
        workspacePath,
        kind: 'manual_feature',
        entityId: task.id,
        label: task.id,
        importance: 'structural',
      });
    })
  );
};
