import { createArchitectPlan, getArchitectPlan, listArchitectPlans, listArchitectPlanTargetBranches, type ArchitectPlanRecord } from '../architectPlanService';
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from '../../stores/useAgsdlStore';
import { AGSDL_EXAMPLES, createExample } from './examples';
import { applyChanges, object, readDocument, text } from './document';
import { readDesign, withDesign, type DesignMetadata } from './design';

export interface DesignSource {
  id: string;
  name: string;
  kind: 'system' | 'blueprint';
  source: string;
  annexes: Record<string, string>;
  origin?: DesignMetadata['origin'];
  builtin?: boolean;
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
  store: typeof useAgsdlStore.getState;
}
const dependencies = (): BlueprintDependencies => ({ listBranches: listArchitectPlanTargetBranches, listPlans: listArchitectPlans, getPlan: getArchitectPlan, createPlan: createArchitectPlan, store: useAgsdlStore.getState });
export async function listDesignSources(deps = dependencies()): Promise<DesignSource[]> {
  const branches = await deps.listBranches();
  const groups = await Promise.all(branches.map(async branch => {
    const { plans } = await deps.listPlans(branch);
    return Promise.all(plans.filter(plan => plan.hasAgsdl && plan.status !== 'deleted' && plan.status !== 'archived').map(async summary => {
      const plan = await deps.getPlan(branch, summary.id);
      if (!plan?.agsdl) return null;
      const name = plan.label || text(object(object(readDocument(plan.agsdl.source).root).annotations).title) || plan.title;
      return { id: JSON.stringify([branch, plan.id]), name, kind: readDesign(plan.agsdl.source).kind, source: plan.agsdl.source, annexes: { ...plan.agsdl.annexes }, origin: { planId: plan.id, name, revision: plan.agsdl.revision } } satisfies DesignSource;
    }));
  }));
  return [...builtInDesignSources(), ...groups.flat().filter((item): item is NonNullable<typeof item> => item !== null)];
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
  return deps.createPlan({ branchName: target.branchName, label: name.trim(), title: name.trim(), description: readDesign(source).purpose, status: 'draft', projectIds: plan.projectIds ?? (plan.projectId ? [plan.projectId] : []), contextProjectIds: plan.contextProjectIds, setActive: false, agsdl: { source, annexes } });
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
