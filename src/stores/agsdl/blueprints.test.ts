import { describe, expect, it } from 'bun:test';
import { agsdlSessionKey, type AgsdlSession, type useAgsdlStore } from '../useAgsdlStore';
import type { ArchitectPlanRecord } from '../../services/architectPlanService';
import { builtInDesignSources, instantiateDesign, listDesignSources, saveBlueprint, type BlueprintDependencies } from './blueprints';
import { readDesign } from '../../services/agsdl/design';

const target = { branchName: 'feature/design', planId: 'source' };
function harness(source = '') {
  const session: AgsdlSession = { source, annexes: { notes: 'Synthetic project guidance' }, version: 'v1', persistedRevision: 3, dirty: false, saving: false, status: 'draft', history: [], future: [], reports: [], error: null };
  const plan: ArchitectPlanRecord = { id: 'source', slug: 'source', title: 'Source', description: '', status: 'draft', targetBranch: target.branchName, createdAt: '', updatedAt: '', nodes: [], predictedBranches: [], projectIds: ['project'], agsdl: { source, annexes: session.annexes, revision: 3 } };
  let saved = 0;
  let created: Parameters<BlueprintDependencies['createPlan']>[0] | undefined;
  const state: ReturnType<typeof useAgsdlStore.getState> = {
    sessions: { [agsdlSessionKey(target)]: session },
    load: async () => session,
    replace: (_target, next, annexes, version) => {
      if (version !== session.version) throw new Error('Conflict');
      session.source = next; session.annexes = annexes!; session.version = 'v2'; session.dirty = true;
    },
    save: async () => { saved++; session.dirty = false; },
    edit: () => { throw new Error('Unexpected edit'); }, undo: () => {}, validate: async () => {},
  };
  const deps: BlueprintDependencies = {
    store: () => state,
    listBranches: async () => [target.branchName],
    listPlans: async () => ({ activePlanId: null, plans: [{ ...plan, nodeCount: 0, hasAgsdl: true }] }),
    getPlan: async () => plan,
    createPlan: async input => { created = input; return { ...plan, id: 'new-blueprint', title: input.title!, agsdl: { ...input.agsdl!, revision: 1 } }; },
  };
  return { session, plan, state, deps, saved: () => saved, created: () => created };
}
describe('design snapshots through Architect metadata', () => {
  it('clones a pinned template and annexes, persists target and leaves template untouched', async () => {
    const h = harness();
    const template = { ...builtInDesignSources()[0], annexes: { guidance: 'Evidence required' }, origin: { planId: 'blueprint', name: 'Release', revision: 7 } };
    const original = JSON.stringify(template);
    await instantiateDesign(target, template, 'v1', {}, h.deps);
    expect(h.saved()).toBe(1);
    expect(readDesign(h.session.source).origin?.revision).toBe(7);
    expect(readDesign(h.session.source).kind).toBe('system');
    expect(JSON.stringify(template)).toBe(original);
    h.session.annexes.guidance = 'Changed';
    expect(template.annexes.guidance).toBe('Evidence required');
  });
  it('rejects stale selections and implicit replacement before touching the target', async () => {
    const h = harness('Existing work');
    await expect(instantiateDesign(target, builtInDesignSources()[0], 'old', { replace: true }, h.deps)).rejects.toThrow('changed');
    await expect(instantiateDesign(target, builtInDesignSources()[0], 'v1', {}, h.deps)).rejects.toThrow('confirmation');
    expect(h.session.source).toBe('Existing work');
    expect(h.saved()).toBe(0);
  });
  it('retains unsaved imported contents if persistence fails', async () => {
    const h = harness();
    h.state.save = async () => { throw new Error('Persistence conflict'); };
    await expect(instantiateDesign(target, builtInDesignSources()[0], 'v1', {}, h.deps)).rejects.toThrow('Persistence conflict');
    expect(h.session.dirty).toBe(true);
    expect(readDesign(h.session.source).kind).toBe('system');
  });
  it('creates a separate blueprint plan without mutating or activating the original', async () => {
    const h = harness(builtInDesignSources()[0].source);
    const before = JSON.stringify(h.session);
    const result = await saveBlueprint(target, 'Reusable release', h.deps);
    expect(result.id).toBe('new-blueprint');
    expect(h.created()?.setActive).toBe(false);
    expect(h.created()?.projectIds).toEqual(['project']);
    expect(h.created()?.agsdl?.annexes).toEqual(h.session.annexes);
    expect(JSON.stringify(h.session)).toBe(before);
    expect(h.saved()).toBe(0);
  });
  it('lists real persisted versions and exposes library failures rather than hiding them', async () => {
    const h = harness(builtInDesignSources()[0].source);
    const sources = await listDesignSources(h.deps);
    expect(sources.find(item => !item.builtin)?.origin?.revision).toBe(3);
    h.deps.listBranches = async () => { throw new Error('Metadata unavailable'); };
    await expect(listDesignSources(h.deps)).rejects.toThrow('Metadata unavailable');
    expect(builtInDesignSources()).toHaveLength(4);
  });
});


describe('blueprint async version boundaries', () => {
  it('does not report application when a document changes while loading', async () => {
    const h = harness();
    h.state.load = async () => { await Promise.resolve(); h.session.version = 'newer'; return h.session; };
    let applied = false;
    await expect(instantiateDesign(target, builtInDesignSources()[0], 'v1', { onApplied: () => { applied = true; } }, h.deps)).rejects.toThrow('changed');
    expect(applied).toBe(false);
    expect(h.session.source).toBe('');
    expect(h.saved()).toBe(0);
  });
  it('reports the applied version before a persistence failure so retry keeps the same snapshot', async () => {
    const h = harness();
    const events: string[] = [];
    h.state.save = async () => { events.push('save'); throw new Error('Persistence failed'); };
    await expect(instantiateDesign(target, builtInDesignSources()[0], 'v1', { onApplied: version => { events.push(`applied:${version}`); } }, h.deps)).rejects.toThrow('Persistence failed');
    expect(events).toEqual(['applied:v2', 'save']);
    expect(h.session.version).toBe('v2');
    expect(h.session.dirty).toBe(true);
  });
  it('rejects saving a newer snapshot than the one selected before asynchronous loading', async () => {
    const h = harness(builtInDesignSources()[0].source);
    h.state.load = async () => { await Promise.resolve(); h.session.version = 'newer'; return h.session; };
    await expect(saveBlueprint(target, 'Pinned blueprint', h.deps, 'v1')).rejects.toThrow('changed');
    expect(h.created()).toBeUndefined();
  });
});


describe('included blueprint adaptation', () => {
  it('offers explicit project guidance to complete without inventing runtime access', () => {
    for (const template of builtInDesignSources()) {
      const design = readDesign(template.source);
      expect(design.purpose.length).toBeGreaterThan(0);
      expect(design.context).toBe('');
      expect(design.requirements).toEqual([{ id: 'projectGuidance', label: 'Project instructions', description: 'Project checklist, commands and conventions to apply.', value: '' }]);
      const runtime = JSON.parse(template.source).runtime;
      expect(runtime.configurations[0].agents.every((agent: { engine: unknown; tools: unknown[] }) => agent.engine === null && agent.tools.length === 0)).toBe(true);
    }
  });
});
