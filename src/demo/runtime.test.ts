import type { DemoBlueprint, DemoBlueprintUse } from './blueprintLaunch';
import type { Task } from '../types';
import { describe, expect, test } from 'bun:test';
import { demoPlans, demoProjects, demoTasks, demoConversations, demoMessages } from './fixtures';
import { validateDocument } from '../services/agsdl/document';
import { prepareMessage } from '../services/agsdlExecution/content';
import { evaluatePredicate, validateCompletion } from '../services/agsdlExecution/constraints';
import { decode, encode, record } from '../services/agsdlExecution/exact';
import { projectViewer } from '../services/agsdl/viewer';
import { createDemoRuntime, DemoUnsupportedCommand } from './runtime';

describe('isolated Macro demo runtime', () => {
  test('provides projects, real AgSDL source and task conversations', async () => {
    const demo = createDemoRuntime();
    const bootstrap = await demo.invoke('workspace_get_bootstrap') as { standaloneProjects: unknown[] };
    expect(bootstrap.standaloneProjects).toHaveLength(4);
    const file = await demo.invoke('fs_read_file', {
      path: 'branches/main/plans/demo-release/plan.json',
      workspaceScope: 'metadata', workspacePath: '/demo/luma',
    }) as { content: string };
    const plan = JSON.parse(file.content);
    expect(JSON.parse(plan.agsdl.source).agents).toBeDefined();
    expect(await demo.invoke('db_list_messages', { conversationId: 'demo-task-chat' })).toHaveLength(2);
  });

  test('keeps metadata separated between synthetic projects', async () => {
    const demo = createDemoRuntime();
    const path = 'branches/main/plans/demo-release/plan.json';
    await demo.invoke('fs_read_file', { path, workspaceScope: 'metadata', workspacePath: '/demo/luma' });
    await expect(demo.invoke('fs_read_file', { path, workspaceScope: 'metadata', workspacePath: '/demo/atlas' })).rejects.toThrow('introuvable');
  });

  test('writes only to memory and a new runtime resets the scenario', async () => {
    const demo = createDemoRuntime();
    const path = '/demo/luma/README.md';
    await demo.invoke('fs_write_file', { path, content: 'Changed in the demo' });
    expect(await demo.invoke('fs_read_file', { path })).toMatchObject({ content: 'Changed in the demo' });
    expect(await createDemoRuntime().invoke('fs_read_file', { path })).not.toMatchObject({ content: 'Changed in the demo' });
    await demo.invoke('fs_write_file', { path: '/outside/demo/example.txt', content: 'still virtual' });
    expect(demo.files.get('/outside/demo/example.txt')).toBe('still virtual');
  });

  test('persists messages using the same params envelope as the real IPC wrapper', async () => {
    const demo = createDemoRuntime();
    await demo.invoke('db_create_message', { params: { id: 'demo-sent', conversationId: 'demo-chat', role: 'user', content: 'Hello' } });
    expect(await demo.invoke('db_list_messages', { conversationId: 'demo-chat' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'demo-sent', role: 'user', content: 'Hello', conversation_id: 'demo-chat' }),
    ]));
  });

  test('stores settings and supports conditional updates without a database', async () => {
    const demo = createDemoRuntime();
    expect(await demo.invoke('db_compare_and_swap_app_setting', { key: 'draft', expectedValueJson: null, valueJson: 'first' })).toEqual({ applied: true });
    expect(await demo.invoke('db_compare_and_swap_app_setting', { key: 'draft', expectedValueJson: null, valueJson: 'lost' })).toEqual({ applied: false });
    expect(await demo.invoke('db_get_app_setting', { key: 'draft' })).toMatchObject({ value_json: 'first' });
    expect(await createDemoRuntime().invoke('db_get_app_setting', { key: 'draft' })).toBeNull();
  });

  test('simulates a response and Stop cancels it', async () => {
    const events: string[] = [];
    const demo = createDemoRuntime(name => events.push(name));
    await demo.invoke('ai_stream_chat', { request: { request_id: 'cancelled' } });
    await demo.invoke('ai_cancel_stream', { requestId: 'cancelled' });
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(events).toEqual([]);
    await demo.invoke('ai_stream_chat', { request: { request_id: 'complete' } });
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(events).toEqual(['ai:stream', 'ai:done']);
  });

  test('never forwards unknown commands or arbitrary native HTTP requests', async () => {
    const demo = createDemoRuntime();
    await expect(demo.invoke('shell_execute', { command: 'anything' })).rejects.toBeInstanceOf(DemoUnsupportedCommand);
    await expect(demo.invoke('plugin:http|fetch', { clientConfig: { url: 'https://example.invalid' } })).rejects.toBeInstanceOf(DemoUnsupportedCommand);
    expect(demo.unsupported.has('shell_execute')).toBe(true);
  });
});

describe('populated demo scenarios', () => {
  test('all authored systems pass the AgSDL reader and project their real graph structure', async () => {
    const kinds = new Set<string>();
    for (const plan of demoPlans) {
      const reports = await validateDocument(plan.agsdl.source);
      for (const report of reports) {
        if (typeof report.documentReportJson !== 'string') throw new Error('Missing AgSDL reader report');
        expect(JSON.parse(report.documentReportJson).valid).toBe(true);
      }
      const viewer = projectViewer(plan.agsdl.source, plan.agsdl);
      if (viewer.graphs.length) {
        expect(viewer.graphs[0].cards.length).toBeGreaterThanOrEqual(5);
        for (const graph of viewer.graphs) for (const card of graph.cards) kinds.add(card.kind);
      } else expect(viewer.declarations.filter(card => card.kind === 'Agent')).toHaveLength(3);
    }
    expect([...kinds]).toEqual(expect.arrayContaining(['agent', 'prepare', 'call', 'condition', 'approval', 'join', 'compose']));
  });
  test('exposes reusable compositions, persistent steering and adaptive participants without fabricating flow', () => {
    const delivery = demoPlans.find(plan => plan.id === 'demo-delivery')!;
    const source = JSON.parse(delivery.agsdl.source);
    expect(source.flow.steps.web.composition).toBe(source.flow.steps.mobile.composition);
    expect(source.flow.steps.web.agents).not.toEqual(source.flow.steps.mobile.agents);
    expect(projectViewer(delivery.agsdl.source, delivery.agsdl).graphs.map(graph => graph.title)).toEqual(['Livraison multi-plateforme', 'Contrôle des preuves', 'Contrôle d’un paquet']);
    const writer = JSON.parse(demoPlans.find(plan => plan.id === 'demo-persistent')!.agsdl.source);
    expect(writer.flow.steps.steer).toMatchObject({ delivery: 'steering', agent: writer.flow.steps.write.agent, steers: 'write' });
    expect(writer.flow.steps.steer.next).toBeUndefined();
    expect(writer.flow.steps.revise.agent).toBe(writer.flow.steps.write.agent);
    expect(writer.agents.writer.configuration.cases).toEqual({ fast: 'fast', thorough: 'thorough' });
    expect(writer.skills.evidence.resources.reference.ref).toBe('reference');
    const incident = JSON.parse(demoPlans.find(plan => plan.id === 'demo-incident')!.agsdl.source);
    expect(Object.keys(incident.flow.steps.triage.next)).toEqual(incident.flow.steps.triage.decision.choices);
    expect(incident.flow.steps.investigate.maxVisits).toBe(3);
    const resident = demoPlans.find(plan => plan.id === 'demo-resident')!;
    expect(JSON.parse(resident.agsdl.source).flow).toBeUndefined();
    expect(projectViewer(resident.agsdl.source, resident.agsdl).graphs).toEqual([]);
  });
  test('prepared writer text is wrapped as information instead of interpreted as a Source', () => {
    const document = record(decode(demoPlans.find(plan => plan.id === 'demo-persistent')!.agsdl.source));
    const steps = record(record(document.flow).steps);
    for (const [step, resource] of [['advice', 'guidance'], ['finish', 'dossier']]) {
      const message = prepareMessage(document, record(steps[step]), { text: 'Texte conservé\navec ses accents.' });
      expect(JSON.parse(encode(message)).resources[resource]).toEqual({ value: 'Texte conservé\navec ses accents.', mediaType: 'text/plain' });
    }
  });
  test('structured extraction rejects malformed output and prepares a correction for the same participant', () => {
    const document = record(decode(demoPlans.find(plan => plan.id === 'demo-structured')!.agsdl.source));
    const agent = record(record(document.agents).extractor), steps = record(record(document.flow).steps), step = record(steps.extract);
    const result = (value: unknown) => decode(JSON.stringify({ results: { report: { value, mediaType: 'application/json' } } }));
    for (const bad of [{ sku: 'A1', price: '49', currency: 'EUR' }, { sku: 'A1', price: 49, currency: 'GBP' }, { sku: 'A1', price: 49 }, { sku: 'A1', price: 49, currency: 'EUR', extra: true }]) {
      expect(() => validateCompletion(record(agent.interface), step, result(bad))).toThrow();
    }
    expect(() => validateCompletion(record(agent.interface), step, result({ sku: 'A1', price: 49, currency: 'EUR' }))).not.toThrow();
    const error = { code: 'OUTPUT_CONSTRAINT', message: 'Format incorrect', details: [] };
    const predicate = record(steps.correctable).test;
    expect(evaluatePredicate(predicate, { error })).toBe(true);
    expect(evaluatePredicate(predicate, { error: { ...error, code: 'AGENT_FAILED' } })).toBe(false);
    const message = JSON.parse(encode(prepareMessage(document, record(steps.feedback), { error })));
    expect(message.resources.outputErrors.value).toEqual(error);
    expect(record(steps.feedback).next).toEqual(['extract']);
    expect(step.agent).toBe('extractor');
  });
  test('competition accepts only an approved result and approvals form an ordered chain for one captured action', () => {
    const race = JSON.parse(demoPlans.find(plan => plan.id === 'demo-competition')!.agsdl.source);
    expect(race.flow.steps.winner).toMatchObject({ mode: 'first', remaining: 'stop-and-wait' });
    for (const approved of [true, false]) expect(evaluatePredicate(decode(JSON.stringify(race.flow.steps.winner.accept)), { results: { report: { value: { approved } } } })).toBe(approved);
    const publication = JSON.parse(demoPlans.find(plan => plan.id === 'demo-approvals')!.agsdl.source);
    expect(publication.flow.steps.editorial.next.approved).toEqual(['legal']);
    expect(publication.flow.steps.legal.next.approved).toEqual(['publish']);
    expect(publication.flow.steps.editorial.call).toBe('publish');
    expect(publication.flow.steps.legal.call).toBe('publish');
    expect(publication.bindings.publication.effects).toBe('external');
  });
  test('crisis system combines first/all joins, reusable expertise, three decisions and protected external effects', () => {
    const plan = demoPlans.find(plan => plan.id === 'demo-crisis')!;
    const source = JSON.parse(plan.agsdl.source), viewer = projectViewer(plan.agsdl.source, plan.agsdl);
    expect(Object.keys(source.flow.steps)).toHaveLength(20);
    expect(source.flow.steps.first).toMatchObject({ mode: 'first', remaining: 'finish', members: ['metrics', 'traces', 'customer'] });
    expect(source.flow.steps.all).toMatchObject({ mode: 'all', members: ['technical', 'business'] });
    expect(source.flow.steps.decide.decision.choices).toEqual(['intervenir', 'observer', 'escalader']);
    expect(['intervention', 'observation', 'closure'].map(name => source.flow.steps[name].composition)).toEqual(['assessment', 'assessment', 'assessment']);
    const cards = viewer.graphs[0].cards;
    expect(cards.find(card => card.id === 'metrics')?.capabilities).toMatchObject({ skills: ['Preuves', 'Diagnostic'], structuredResults: true, dynamicConfiguration: true, externalEffects: false });
    expect(cards.find(card => card.id === 'deploy')?.capabilities?.externalEffects).toBe(true);
    expect(cards.find(card => card.id === 'watch')?.capabilities?.externalEffects).toBe(false);
    expect(source.compositions.assessment.steps.review.onError).toEqual([{ error: true }]);
    const document = record(decode(plan.agsdl.source));
    const steps = record(record(document.flow).steps);
    const report = { value: { approved: true, hypothesis: 'Cache', evidence: ['p95'] }, mediaType: 'application/json' };
    const message = JSON.parse(encode(prepareMessage(document, record(steps.evidence), { members: { technical: { results: { report } }, business: { results: { report } } } })));
    expect(message.resources).toEqual({ technical: report, business: report });
  });
  test('every project has its own plans, conversations and virtual files', async () => {
    const demo = createDemoRuntime();
    for (const project of demoProjects) {
      const context = await demo.invoke('db_get_project_context_state', { projectId: project.id }) as { last_plan_id: string; architect_conversation_id: string };
      expect(demoPlans.find(plan => plan.id === context.last_plan_id)?.projectId).toBe(project.id);
      expect(demoConversations.find(chat => chat.id === context.architect_conversation_id)?.project_id).toBe(project.id);
      expect(await demo.invoke('fs_read_file', { path: `${project.path}/README.md` })).toHaveProperty('content');
      const listing = await demo.invoke('workspace_architect_list_plans', { request: { branchName: 'main', scopedProjectIdsHint: [project.id] } }) as { plans: Array<{ projectId: string }> };
      expect(listing.plans.length).toBeGreaterThan(0);
      expect(listing.plans.every(plan => plan.projectId === project.id)).toBe(true);
      const activation = await demo.invoke('workspace_architect_activate_plan_head', { request: { planId: context.last_plan_id } });
      expect(activation).toMatchObject({ conversationId: context.architect_conversation_id, sharedConversation: false });
    }
  });
  test('remembers the selected plan independently for each project until reload', async () => {
    const demo = createDemoRuntime();
    await demo.invoke('db_upsert_project_context_state', { input: { project_id: 'demo-atlas', last_plan_id: 'demo-quality', architect_conversation_id: 'demo-quality-chat' } });
    expect(await demo.invoke('db_get_project_context_state', { projectId: 'demo-atlas' })).toMatchObject({ last_plan_id: 'demo-quality' });
    expect(await demo.invoke('db_get_project_context_state', { projectId: 'demo-luma' })).toMatchObject({ last_plan_id: 'demo-release' });
    expect(await createDemoRuntime().invoke('db_get_project_context_state', { projectId: 'demo-atlas' })).toMatchObject({ last_plan_id: 'demo-assistant' });
  });
  test('task and conversation references remain consistent across waiting, failed and completed examples', () => {
    expect(new Set(demoTasks.map(task => task.status)).size).toBe(7);
    for (const task of demoTasks) {
      expect(demoPlans.some(plan => plan.id === task.plan_id && plan.projectId === task.project_id)).toBe(true);
      for (const dependency of task.dependencies) expect(demoTasks.some(other => other.id === dependency && other.project_id === task.project_id)).toBe(true);
      if (task.conversation_id) expect(demoConversations.find(chat => chat.id === task.conversation_id)?.task_id).toBe(task.id);
    }
    for (const chat of demoConversations) expect(chat.message_count).toBe(demoMessages.filter(message => message.conversation_id === chat.id).length);
  });
});


describe('demo blueprint preparation and launch', () => {
  test('autosave updates one stable draft without launching tasks', async () => {
    const runtime = createDemoRuntime();
    const id = 'demo-autosaved-draft';
    const first = await runtime.invoke('demo_blueprint_prepare', { id, projectId: 'demo-luma', blueprintId: 'demo-release', objective: 'First input', values: { releaseVersion: '2' } }) as DemoBlueprintUse;
    const last = await runtime.invoke('demo_blueprint_prepare', { id, projectId: 'demo-luma', blueprintId: 'demo-release', objective: 'Latest input', values: { releaseVersion: '2.4.0' } }) as DemoBlueprintUse;
    expect(first.id).toBe(id);
    expect(last.id).toBe(id);
    expect(await runtime.invoke('demo_blueprint_uses')).toEqual([expect.objectContaining({ id, objective: 'Latest input', values: { releaseVersion: '2.4.0' }, state: 'prepared', taskIds: [] })]);
  });

  test('only permits blueprints attached to the target project', async () => {
    const runtime = createDemoRuntime();
    const catalog = await runtime.invoke('demo_blueprint_catalog') as DemoBlueprint[];
    expect(catalog.filter(item => item.projectIds.includes('demo-luma')).map(item => item.id)).toEqual(['demo-release', 'demo-voice']);
    expect(catalog.filter(item => item.projectIds.includes('demo-atlas')).map(item => item.id)).toEqual(['demo-quality']);
    expect(catalog.filter(item => item.projectIds.includes('demo-helio')).map(item => item.id)).toEqual(['demo-ingestion']);
    expect(catalog.filter(item => item.projectIds.includes('demo-meridian')).map(item => item.id)).toEqual(['demo-refund']);
    await expect(runtime.invoke('demo_blueprint_prepare', { projectId: 'demo-atlas', blueprintId: 'demo-release', objective: 'Cross-project test' })).rejects.toThrow('rattaché');
    expect(await runtime.invoke('demo_blueprint_uses')).toEqual([]);
    const atlas = await runtime.invoke('demo_blueprint_prepare', { projectId: 'demo-atlas', blueprintId: 'demo-quality', objective: 'Review QA', values: { model: 'Macro AI · Démo' } }) as DemoBlueprintUse;
    const started = await runtime.invoke('demo_blueprint_start', { id: atlas.id }) as DemoBlueprintUse;
    const tasks = (await runtime.invoke('workspace_list_tasks') as { tasks: Task[] }).tasks.filter(task => started.taskIds.includes(task.id));
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every(task => task.project_id === 'demo-atlas' && task.plan_id === 'demo-quality')).toBe(true);
  });

  test('reads Architect defaults while keeping each prepared use independent', async () => {
    const runtime = createDemoRuntime();
    const path = 'branches/main/plans/demo-release/plan.json';
    const file = await runtime.invoke('fs_read_file', { path, workspaceScope: 'metadata', workspacePath: '/demo/luma' }) as { content: string };
    const plan = JSON.parse(file.content);
    plan.agsdl.design.requirements[0].value = '2.4.0';
    await runtime.invoke('fs_write_file', { path, workspaceScope: 'metadata', workspacePath: '/demo/luma', content: JSON.stringify(plan) });
    const prepared = await runtime.invoke('demo_blueprint_prepare', { projectId: 'demo-luma', blueprintId: plan.id, objective: 'Release QA' }) as DemoBlueprintUse;
    expect(prepared.blueprint.fields[0].value).toBe('2.4.0');
    plan.agsdl.design.requirements[0].value = '3.0.0';
    await runtime.invoke('fs_write_file', { path, workspaceScope: 'metadata', workspacePath: '/demo/luma', content: JSON.stringify(plan) });
    expect((await runtime.invoke('demo_blueprint_catalog') as DemoBlueprint[]).find(item => item.id === plan.id)?.fields[0].value).toBe('3.0.0');
    expect((await runtime.invoke('demo_blueprint_uses') as DemoBlueprintUse[])[0].blueprint.fields[0].value).toBe('2.4.0');
    await expect(runtime.invoke('demo_blueprint_prepare', { projectId: 'unknown', blueprintId: plan.id })).rejects.toThrow('projet');
  });

  test('saves incomplete inputs, resumes the same preparation and rejects an incomplete launch', async () => {
    const runtime = createDemoRuntime();
    const draft = await runtime.invoke('demo_blueprint_prepare', { blueprintId: 'demo-release', projectId: 'demo-luma', objective: 'Release QA', values: { releaseVersion: '2.4' } }) as DemoBlueprintUse;
    expect(draft.state).toBe('prepared');
    expect(draft.taskIds).toEqual([]);
    await expect(runtime.invoke('demo_blueprint_start', { id: draft.id })).rejects.toThrow('Complétez');
    const catalog = await runtime.invoke('demo_blueprint_catalog') as DemoBlueprint[];
    const release = catalog.find(item => item.id === 'demo-release')!;
    const values = Object.fromEntries(release.fields.map(field => [field.id, field.value || 'Exemple QA']));
    const resumed = await runtime.invoke('demo_blueprint_prepare', { id: draft.id, blueprintId: release.id, projectId: 'demo-luma', objective: 'Release QA', values }) as DemoBlueprintUse;
    expect(resumed.id).toBe(draft.id);
    expect(await runtime.invoke('demo_blueprint_uses')).toHaveLength(1);
    const started = await runtime.invoke('demo_blueprint_start', { id: draft.id }) as DemoBlueprintUse;
    const repeat = await runtime.invoke('demo_blueprint_start', { id: draft.id }) as DemoBlueprintUse;
    expect(repeat.taskIds).toEqual(started.taskIds);
    const tasks = (await runtime.invoke('workspace_list_tasks') as { tasks: Task[] }).tasks.filter(task => started.taskIds.includes(task.id));
    expect(tasks).toHaveLength(release.agents.length);
    expect(tasks.filter(task => task.status === 'InProgress')).toHaveLength(1);
    expect(tasks.filter(task => task.status === 'Blocked')).toHaveLength(release.agents.length - 1);
    expect(await runtime.invoke('db_list_messages', { conversationId: tasks[0].conversation_id })).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('Release QA') })]));
    for (let index = 0; index < release.agents.length; index++) await runtime.invoke('demo_blueprint_advance', { id: started.id });
    expect(tasks.every(task => task.status === 'Completed')).toBe(true);
    expect((await runtime.invoke('demo_blueprint_uses') as DemoBlueprintUse[])[0].state).toBe('completed');
    await expect(runtime.invoke('demo_blueprint_prepare', { id: draft.id, blueprintId: release.id, projectId: 'demo-luma' })).rejects.toThrow('déjà été lancée');
    expect(await createDemoRuntime().invoke('demo_blueprint_uses')).toEqual([]);
  });
});
