import * as tauriIpc from './tauriIpc';
import {
  createArchitectPlanMutationId,
  removeArchitectPlanMutationJournal,
  upsertArchitectPlanMutationJournal,
  type ArchitectPlanMutationJournalEntry,
} from './architectPlanMutationJournal';
import { normalizeBranchName, sanitizeId } from './architectPlanReadModel';
import { normalizeProjectRegistryPath } from './validProjectRegistry';
import { recordMacroMetadataMutation } from './macroMetadataCoordinator';

type Transport = Pick<typeof tauriIpc,
  'isTauriAvailable' | 'dbGetAppSetting' | 'dbCompareAndSwapAppSetting' |
  'fsExists' | 'fsReadFileWithOptions' | 'fsWriteFile' | 'fsDelete'>;

export interface ArtifactFileMutation {
  workspacePath: string;
  workspaceScope: 'metadata' | 'direct';
  path: string;
  before: string | null;
  after: string;
}
export interface ArtifactMutationPayload { files: ArtifactFileMutation[] }

export const isArtifactMutation = (
  entry: ArchitectPlanMutationJournalEntry,
): entry is ArchitectPlanMutationJournalEntry<ArtifactMutationPayload> => {
  if (entry.operation !== 'artifacts' || entry.branchName !== normalizeBranchName(entry.branchName) ||
    entry.planId !== sanitizeId(entry.planId)) return false;
  const files = (entry.payload as Partial<ArtifactMutationPayload> | null)?.files;
  const root = `branches/${entry.branchName}/plans/${entry.planId}/`;
  const owners = new Set(entry.workspaceKey.split('|'));
  const keys = new Set<string>();
  return Array.isArray(files) && files.length > 0 && files.every((file) => {
    if (!file || typeof file.path !== 'string' || typeof file.workspacePath !== 'string') return false;
    const relativePath = file.path.slice(root.length);
    const key = `${file.workspaceScope}:${file.workspacePath}:${file.path}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return owners.has(normalizeProjectRegistryPath(file.workspacePath) || '') &&
      (file.workspaceScope === 'metadata' || file.workspaceScope === 'direct') &&
      file.path.startsWith(root) && !file.path.split('/').some((part) => part === '.' || part === '..') &&
      (relativePath === 'manifest.json' || relativePath === 'artifacts/index.json' ||
        /^artifacts\/tasks\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\.(md|json|txt)$/.test(relativePath)) &&
      (file.before === null || typeof file.before === 'string') && typeof file.after === 'string';
  });
};

export const readArtifactFileSnapshot = async (
  file: Pick<ArtifactFileMutation, 'workspacePath' | 'path'> & { workspaceScope: tauriIpc.WorkspaceScope },
  transport: Transport = tauriIpc,
): Promise<{ content: string | null; revision: string | undefined }> => {
  if (!await transport.fsExists(file.path, file)) return { content: null, revision: 'absent' };
  const snapshot = await transport.fsReadFileWithOptions({ ...file, allowOutsideWorkspace: false });
  return { content: snapshot.content, revision: snapshot.revision ?? undefined };
};

const setFile = async (file: ArtifactFileMutation, content: string | null, transport: Transport): Promise<void> => {
  const current = await readArtifactFileSnapshot(file, transport);
  if (current.content === content) return;
  if (current.content !== file.before && current.content !== file.after) {
    throw new Error(`Artifact recovery conflict: ${file.path}`);
  }
  if (!current.revision) throw new Error(`Artifact revision unavailable: ${file.path}`);
  if (content === null) {
    await transport.fsDelete({ ...file, expectedRevision: current.revision });
  } else {
    await transport.fsWriteFile({
      ...file, content, createDirs: true, allowOutsideWorkspace: false, expectedRevision: current.revision,
    });
  }
};

/** Called under the Plans workspace lock. Incomplete writes roll back; the durable
 * files_applied marker is the commit point. Before-images survive until recovery succeeds. */
export const recoverArtifactMutation = async (
  entry: ArchitectPlanMutationJournalEntry<ArtifactMutationPayload>,
  transport: Transport = tauriIpc,
): Promise<void> => {
  const committed = entry.phase === 'files_applied' || entry.phase === 'committing';
  for (const file of entry.payload.files) {
    const current = await readArtifactFileSnapshot(file, transport);
    if (committed ? current.content !== file.after : current.content !== file.before && current.content !== file.after) {
      throw new Error(`Artifact recovery conflict: ${file.path}`);
    }
  }
  if (!committed) {
    for (const file of [...entry.payload.files].reverse()) await setFile(file, file.before, transport);
  } else {
    for (const workspacePath of new Set(entry.payload.files
      .filter((file) => file.workspaceScope === 'metadata').map((file) => file.workspacePath))) {
      recordMacroMetadataMutation({ workspacePath, kind: 'task_metadata', entityId: entry.planId,
        label: 'task artifacts', importance: 'light' });
    }
  }
  await removeArchitectPlanMutationJournal(entry.id, transport);
};

/** Caller owns both the branch mutation queue and the Plans workspace lock. */
export const persistArtifactMutation = async (params: {
  branchName: string;
  planId: string;
  workspaceKey: string;
  files: ArtifactFileMutation[];
}, transport: Transport = tauriIpc): Promise<void> => {
  const now = new Date().toISOString();
  const entry: ArchitectPlanMutationJournalEntry<ArtifactMutationPayload> = {
    branchName: params.branchName, planId: params.planId, workspaceKey: params.workspaceKey,
    id: createArchitectPlanMutationId({ ...params, operation: 'artifacts' }),
    operation: 'artifacts', phase: 'prepared', payload: { files: params.files },
    createdAt: now, updatedAt: now,
  };
  if (!isArtifactMutation(entry)) throw new Error('Invalid artifact mutation scope or payload.');
  await upsertArchitectPlanMutationJournal(entry, transport);
  try {
    for (const file of entry.payload.files) await setFile(file, file.after, transport);
  } catch (error) {
    await recoverArtifactMutation(entry, transport);
    throw error;
  }
  const committed = { ...entry, phase: 'files_applied' as const, updatedAt: new Date().toISOString() };
  await upsertArchitectPlanMutationJournal(committed, transport);
  await recoverArtifactMutation(committed, transport);
};
