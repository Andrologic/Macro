import { createArchitectPlan, getArchitectPlan, listArchitectPlans, listArchitectPlanTargetBranches, type ArchitectPlanRecord } from '../../services/architectPlanService';
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from '../useAgsdlStore';
import { AGSDL_EXAMPLES, createExample } from '../../services/agsdl/examples';
import { applyChanges, object, readDocument, text } from '../../services/agsdl/document';
import { readDesign, withDesign, type DesignMetadata } from '../../services/agsdl/design';
import { useAppStore } from '../useAppStore';

export interface DesignSource {
  id: string;
  name: string;
  kind: 'system' | 'blueprint';
  source: string;
  annexes: Record<string, string>;
  origin?: DesignMetadata['origin'];
  builtin?: boolean;
}
export interface DesignSourceLoadResult {
  sources: DesignSource[];
  failureCount: number;
}
const examplePurposes = {
  feature: 'Implement and verify the requested change.',
  release: 'Check release prerequisites and collect verification evidence.',
  hotfix: 'Diagnose and correct an urgent incident.',
  bugfix: 'Reproduce and fix a defect, then verify the correction.',
};
export function builtInDesignSources(): DesignSource[] {
  return AGSDL_EXAMPLES.map(kind => {
    const source = createExample(kind);
    const name = kind[0].toUpperCase() + kind.slice(1);
    return { id: `builtin:${kind}`, name, origin: { planId: `builtin:${kind}`, name, revision: 1 }, kind: 'blueprint', builtin: true, source: withDesign(source, { ...readDesign(source), kind: 'blueprint', purpose: examplePurposes[kind], requirements: [{ id: 'projectGuidance', label: 'Project instructions', description: 'Project checklist, commands and conventions to apply.', value: '' }] }), annexes: {} };
  });
}
/** Injection uses the same metadata and editor contracts, without a parallel persistence layer. */
export interface BlueprintDependencies {
  listBranches: typeof listArchitectPlanTargetBranches;
  listPlans: typeof listArchitectPlans;
  getPlan: typeof getArchitectPlan;
  createPlan: typeof createArchitectPlan;
  refreshCatalog?: () => Promise<unknown>;
  store: typeof useAgsdlStore.getState;
}
const dependencies = (): BlueprintDependencies => ({
  listBranches: listArchitectPlanTargetBranches,
  listPlans: listArchitectPlans,
  getPlan: getArchitectPlan,
  createPlan: createArchitectPlan,
  refreshCatalog: () => useAppStore.getState().loadMacroProjectMetadataForSelection({
    hydrateActivePlan: false,
    preserveCurrentActivePlan: true,
    refreshTasks: false,
    reason: 'manual',
  }),
  store: useAgsdlStore.getState,
});
export async function listDesignSources(deps = dependencies()): Promise<DesignSourceLoadResult> {
  const branches = await deps.listBranches();
  const groups = await Promise.all(branches.map(async branch => {
    try {
      const { plans } = await deps.listPlans(branch);
      const entries = await Promise.all(plans
        .filter(plan => plan.hasAgsdl && plan.status !== 'deleted' && plan.status !== 'archived')
        .map(async summary => {
          try {
            const plan = await deps.getPlan(branch, summary.id);
            // A stale catalog entry can legitimately have no snapshot (for example
            // after undo). It is not a malformed document and should not hide the
            // usable entries or show a misleading load error.
            if (!plan?.agsdl || !plan.agsdl.source.trim()) return { source: undefined, failureCount: 0 };
            const name = plan.label || text(object(object(readDocument(plan.agsdl.source).root).annotations).title) || plan.title;
            return {
              source: { id: JSON.stringify([branch, plan.id]), name, kind: readDesign(plan.agsdl.source).kind, source: plan.agsdl.source, annexes: { ...plan.agsdl.annexes }, origin: { planId: plan.id, name, revision: plan.agsdl.revision } } satisfies DesignSource,
              failureCount: 0,
            };
          } catch {
            return { source: undefined, failureCount: 1 };
          }
        }));
      return {
        sources: entries.flatMap(entry => entry.source ? [entry.source] : []),
        failureCount: entries.reduce((count, entry) => count + entry.failureCount, 0),
      };
    } catch {
      return { sources: [], failureCount: 1 };
    }
  }));
  return {
    sources: [...builtInDesignSources(), ...groups.flatMap(group => group.sources)],
    failureCount: groups.reduce((count, group) => count + group.failureCount, 0),
  };
}
export async function saveBlueprint(target: AgsdlTarget, name: string, deps = dependencies(), expectedVersion?: string): Promise<ArchitectPlanRecord> {
  if (!name.trim()) throw new Error('Give the blueprint a name.');
  const session = await deps.store().load(target);
  if (expectedVersion !== undefined && session.version !== expectedVersion) throw new Error('The document changed. Read it again before editing.');
  if (!session.source.trim()) throw new Error('Create a system before saving a blueprint.');
  if (session.saving) throw new Error('Wait for the current save to finish.');
  // Snapshot before any await: subsequent edits never leak into this saved blueprint.
  const source = applyChanges(withDesign(session.source, { ...readDesign(session.source), kind: 'blueprint' }), [{ op: 'set', path: '/root/annotations/title', valueJson: JSON.stringify(name.trim()) }]);
  const annexes = { ...session.annexes };
  const plan = await deps.getPlan(target.branchName, target.planId);
  if (!plan || plan.status === 'deleted') throw new Error('The source plan is unavailable.');
  const created = await deps.createPlan({ branchName: target.branchName, label: name.trim(), title: name.trim(), description: readDesign(source).purpose, status: 'draft', projectIds: plan.projectIds ?? (plan.projectId ? [plan.projectId] : []), contextProjectIds: plan.contextProjectIds, setActive: false, agsdl: { source, annexes } });
  // Keep the Architect navigator/sidebar in sync with the newly persisted plan.
  // A refresh failure must not turn a successful save into a reported failure.
  if (deps.refreshCatalog) {
    try { await deps.refreshCatalog(); } catch { /* the saved plan remains valid */ }
  }
  return created;
}
export async function instantiateDesign(target: AgsdlTarget, source: DesignSource, expectedVersion: string, options: { replace?: boolean; onApplied?: (version: string) => void } = {}, deps = dependencies()): Promise<void> {
  // A library entry is already a pinned snapshot, including its annexes and revision.
  const design = readDesign(source.source);
  const copy = withDesign(source.source, { ...design, kind: 'system', origin: source.origin });
  const annexes = { ...source.annexes };
  await deps.store().load(target);
  const session = deps.store().sessions[agsdlSessionKey(target)];
  if (!session || session.version !== expectedVersion) throw new Error('The document changed. Read it again before editing.');
  if (session.saving) throw new Error('Wait for the current save to finish.');
  if (session.source.trim() && !options.replace) throw new Error('Replacing a nonempty system requires explicit confirmation.');
  deps.store().replace(target, copy, annexes, expectedVersion);
  options.onApplied?.(deps.store().sessions[agsdlSessionKey(target)].version);
  // Save failures deliberately retain the editable snapshot, error and undo history.
  await deps.store().save(target);
}
