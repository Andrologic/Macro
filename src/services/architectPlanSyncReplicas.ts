import {
  logArchitectPlanSanitization,
  parseJsonLines,
  pickCanonicalReplica,
  type ArchitectPlanReplicaSnapshot,
  type ArchitectPlanReplicaSnapshotDiagnostics,
} from './architectPlanReadModel';
import type { ResolvedArchitectPlanServiceDependencies } from './architectPlanReadContext';
import type { ValidProjectRegistrySnapshot } from './validProjectRegistry';
import { buildUpsertReplicaMutationTarget, runArchitectPlanReplicaMutation } from './architectPlanMutationPersistence';

/** Repair only replicas already proven equivalent by the reader. The same durable
 * transaction path as user mutations owns every write and interrupted recovery.
 */
export const synchronizeSanitizedArchitectPlanReplicas = async (params: {
  branchName: string;
  snapshots: ArchitectPlanReplicaSnapshot[];
  snapshotDiagnostics: ArchitectPlanReplicaSnapshotDiagnostics[];
  removedInvalidProjectIds: string[];
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined;
  deps: ResolvedArchitectPlanServiceDependencies;
}): Promise<void> => {
  const { branchName, snapshots, snapshotDiagnostics, removedInvalidProjectIds, registrySnapshot, deps } = params;
  const canonicalSnapshot = pickCanonicalReplica(
    snapshots.map((snapshot) => ({
      ...snapshot,
      updatedAt: snapshot.plan.updatedAt,
      repoPath: snapshot.scope.repoPath,
    })),
    'newest'
  );
  logArchitectPlanSanitization({
    branchName: branchName,
    planId: canonicalSnapshot.plan.id,
    removedInvalidProjectIds,
    context: removedInvalidProjectIds.length > 0
      ? 'replica_auto_heal'
      : 'replica_target_branch_auto_heal',
  });
  const canonicalMessages = parseJsonLines(canonicalSnapshot.files['chat.jsonl'] || '');
  const extraFiles = Object.fromEntries(
    Object.entries(canonicalSnapshot.files).filter(([relativePath]) => relativePath.startsWith('artifacts/'))
  );
  const targets = await Promise.all(snapshotDiagnostics.map((snapshot) =>
    buildUpsertReplicaMutationTarget({
      scope: snapshot.scope,
      branchName: branchName,
      plan: canonicalSnapshot.plan,
      registrySnapshot: registrySnapshot,
      chatMessages: canonicalMessages,
      chatMessageCount: canonicalMessages.length,
      extraFiles,
    })
  ));
  await runArchitectPlanReplicaMutation({
    branchName: branchName,
    planId: canonicalSnapshot.plan.id,
    operation: 'auto_heal',
    targets,
    registrySnapshot: registrySnapshot,
    deps: deps,
    commitMessage: `chore(metadata): auto-heal architect plan ${canonicalSnapshot.plan.id}`,
  });
};
