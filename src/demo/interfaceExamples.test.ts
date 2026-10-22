import { describe, expect, test } from 'bun:test';
import { demoPlans, demoTasks, demoMessages, demoExecutionGraphs } from './fixtures';
import { demoNavigationPreferences } from './navigationExamples';
import { normalizeBlueprintFolders, blueprintFolderAncestors, canMoveBlueprintFolder, moveBlueprintToFolder } from '../services/blueprintFolders';
import { toPlanLocatorKey } from '../services/durableIdentity';
import { mapDbMessageToChatMessage } from '../services/chatDbMappers';
import { getArchitectPlanPrimaryName } from '../services/architectPlanPresentation';
import { normalizePlanIcon } from '../services/planIcon';
import { createDemoRuntime } from './runtime';
import { missingBlueprintFields, type DemoBlueprintUse } from './blueprintLaunch';
import { buildQuestionnaireResponseArtifacts } from '../services/chatQuestionnaires';

describe('interface examples', () => {
  test('loads a real nested organization, including empty folders, repeated names and collapsed search targets', () => {
    const preferences = demoNavigationPreferences();
    const state = preferences.architectBlueprintFolders;
    expect(normalizeBlueprintFolders(state)).toEqual(state);
    expect(blueprintFolderAncestors(state, 'mobile-checks').map(folder => folder.name)).toEqual(['Produit', 'Livraison', 'Contrôles']);
    expect(state.folders.filter(folder => folder.name === 'Contrôles')).toHaveLength(3);
    expect(state.collapsedIds).toContain('helio-incidents');
    expect(Object.values(state.placements)).not.toContain('common-empty');
    for (const [key, folderId] of Object.entries(state.placements)) {
      const [scope, locator] = JSON.parse(key);
      const plan = demoPlans.find(plan => toPlanLocatorKey({ branchName: 'main', planId: plan.id }) === locator);
      expect(plan).toBeDefined();
      expect(scope).toBe(`project:${plan!.projectId}`);
      expect(state.folders.find(folder => folder.id === folderId)?.scopeId).toBe(scope);
    }
    expect(canMoveBlueprintFolder(state, 'mobile', 'mobile-checks')).toBe(false);
    expect(() => moveBlueprintToFolder(state, 'project:demo-luma', toPlanLocatorKey({ branchName: 'main', planId: 'demo-release' }), 'common-empty')).toThrow();
  });

  test('includes scoped namesakes, custom icons and long labels without duplicating identities', () => {
    expect(new Set(demoPlans.map(plan => plan.id)).size).toBe(demoPlans.length);
    expect(demoPlans.filter(plan => getArchitectPlanPrimaryName(plan) === 'Assistant').map(plan => plan.projectId)).toEqual(['demo-atlas', 'demo-macro-library']);
    expect(demoPlans.every(plan => normalizePlanIcon(plan.icon))).toBe(true);
    expect(demoPlans.some(plan => plan.label.length > 65)).toBe(true);
    expect(demoTasks.some(task => task.title.length > 75)).toBe(true);
  });

  test('keeps a newly created empty common blueprint out of the launch catalogue', async () => {
    const runtime = createDemoRuntime();
    const empty = structuredClone(runtime.plans.find(plan => plan.id === 'macro-assistant')!);
    empty.id = 'demo-empty-common';
    const source = JSON.parse(empty.agsdl.source);
    source.agents = {};
    delete source.flow;
    empty.agsdl.source = JSON.stringify(source);
    runtime.plans.push(empty);
    const catalog = await runtime.invoke('demo_blueprint_catalog') as Array<{ id: string }>;
    expect(catalog.some(blueprint => blueprint.id === empty.id)).toBe(false);
    await expect(runtime.invoke('demo_blueprint_prepare', { blueprintId: empty.id, projectId: 'demo-empty' })).rejects.toThrow('introuvable');
  });

  test('provides an incomplete preparation that can resume without creating duplicate tasks', async () => {
    const runtime = createDemoRuntime();
    const [draft] = await runtime.invoke('demo_blueprint_uses') as DemoBlueprintUse[];
    expect(draft.id).toBe('demo-prepared-release');
    expect(draft.values).toEqual({ releaseVersion: '1.8.0' });
    expect(missingBlueprintFields(draft.blueprint, draft.values)).toEqual(['releasePackages', 'releaseRepository']);
    const count = runtime.tasks.length;
    await expect(runtime.invoke('demo_blueprint_start', { id: draft.id })).rejects.toThrow('Complétez');
    const resumed = await runtime.invoke('demo_blueprint_prepare', { id: draft.id, blueprintId: draft.blueprint.id, projectId: draft.projectId, values: { ...draft.values, releasePackages: 'Paquets iOS et Android', releaseRepository: 'Dépôt fictif' } }) as DemoBlueprintUse;
    const run = await runtime.invoke('demo_blueprint_start', { id: resumed.id }) as DemoBlueprintUse;
    await runtime.invoke('demo_blueprint_start', { id: resumed.id });
    expect(runtime.tasks).toHaveLength(count + run.taskIds.length);
  });

  test('hydrates a multi-step questionnaire and preserves structured answers across message reload', async () => {
    const task = demoTasks.find(task => task.id === 'demo-transcript')!;
    const message = demoMessages.find(message => message.conversation_id === task.conversation_id && message.role === 'assistant')!;
    const rendered = mapDbMessageToChatMessage(message, new Map());
    expect(rendered.questionnaire?.questions).toHaveLength(2);
    const payload = rendered.questionnaire!;
    const artifacts = buildQuestionnaireResponseArtifacts(message.id, payload, { 'first-name': 'Ana', 'second-name': 'Maël' });
    const runtime = createDemoRuntime();
    await runtime.invoke('db_create_message', { params: { id: 'demo-question-answer', conversationId: task.conversation_id, role: 'user', content: artifacts.visibleContent, hiddenContext: artifacts.hiddenContext, contextRefsJson: '[]' } });
    const saved = (await runtime.invoke('db_list_messages', { conversationId: task.conversation_id }) as typeof demoMessages).find(message => message.id === 'demo-question-answer')!;
    expect(saved.context_refs_json).toBe('[]');
    expect(mapDbMessageToChatMessage(saved, new Map()).questionnaire_response_summary?.items.map(item => item.answer)).toEqual(['Ana', 'Maël']);
  });

  test('shows the denied route and a failed external call in separate executions of the same blueprint', () => {
    const denied = demoExecutionGraphs.find(graph => graph.taskPaths['/flow/steps/alternative'] === 'demo-refund-alternative')!;
    const original = demoExecutionGraphs.find(graph => graph.taskPaths['/flow/steps/approval'] === 'demo-refund-review')!;
    expect(denied.title).toContain('1049');
    expect(Object.values(denied.taskPaths).some(id => Object.values(original.taskPaths).includes(id))).toBe(false);
    expect(denied.activity?.['/flow/steps/refund']).toBeUndefined();
    expect(demoExecutionGraphs.find(graph => Object.values(graph.taskPaths).includes('demo-publication-recovery'))?.activity?.['/flow/steps/publish'].state).toBe('failed');
  });
});
