import { blueprintAgentTasks, missingBlueprintFields, type DemoBlueprint, type DemoBlueprintUse } from './blueprintLaunch';
import { macroNativeModelEdition } from '../services/agsdl/nativeModelEdition';
import { demoSkill, demoProjects, demoTasks, demoPlans, demoConversations, demoMessages, demoProvider, demoModel, demoMessage, DEMO_DATE } from './fixtures';
import type { ConfigDocumentKind, ConfigSnapshot, ConfigDocument, JsonPatchOperation } from '../types/generated/config';
import type { TerminalTabDto } from '../types/generated/ipc/TerminalTabDto';
import type { DbConversation } from '../services/tauriIpc';
type Args = Record<string, unknown>;
const object = (v: unknown): Args => v && typeof v === 'object' && !Array.isArray(v) ? v as Args : {};
const string = (v: unknown): string => typeof v === 'string' ? v : '';
export class DemoUnsupportedCommand extends Error {
  constructor(public command: string) { super(`Mode démo : cette action n’est pas encore simulée (${command}).`); }
}
/** In-memory backend. Unknown operations fail closed, never forwarded to Tauri. */
export function createDemoRuntime(emit: (name: string, payload: unknown) => void = () => { }) {
  const projects = structuredClone(demoProjects);
  const tasks = structuredClone(demoTasks);
  const plans = structuredClone(demoPlans);
  const conversations = structuredClone(demoConversations);
  const messages = structuredClone(demoMessages);
  const values: Args = { leftPanelWidth: 300, architectLeftPanelWidth: 300, rightPanelWidth: 420, lastActiveMode: 'Architect', lastSelectedProjectId: 'demo-luma', lastOpenProjectPath: '/demo/luma', isLeftPanelOpen: true, isRightPanelOpen: true, onboardingState: { completed: true }, architectNavigatorExpandedScopeIds: ['project:demo-luma', 'demo-luma'], aiContextSelections: {} };
  const settings = new Map<string, string>();
  const blueprintUses = new Map<string, DemoBlueprintUse>();
  let sessionContext: Args = { mode: 'Architect', selected_project_id: 'demo-luma', selected_group_id: null, selected_task_id: null, active_plan_id: 'demo-release' };
  const projectContexts = new Map<string, Args>(projects.map(project => {
    const plan = plans.find(plan => plan.projectId === project.id);
    return [project.id, { project_id: project.id, last_plan_id: plan?.id ?? null, architect_conversation_id: plan?.conversationId ?? null,
      implement_conversation_id: tasks.find(task => task.project_id === project.id && task.conversation_id)?.conversation_id ?? null }];
  }));
  const transcriptSync = new Map<string, Args>(demoPlans.map(p=>[p.conversationId,{conversation_id:p.conversationId,plan_id:p.id,target_branch:'main',transcript_revision:null,message_count:2,updated_at:DEMO_DATE}]));
  const files = new Map<string, string>([
    ['/demo/luma/README.md', '# Luma Mobile\n\nApplication de notes vocales. Projet fictif du mode démo.'],
    ['/demo/luma/package.json', JSON.stringify({ name: 'luma-mobile', version: '1.8.0', scripts: { test: 'vitest', build: 'vite build' } }, null, 2)],
    ['/demo/luma/src/audio/player.ts', 'export async function resumeAudio(position: number) {\n  await player.prepare();\n  await player.seek(position);\n  await player.play();\n}\n'],
    ['/demo/luma/src/App.tsx', 'export default function App() {\n  return <main>Luma Mobile</main>;\n}\n'],
    ['/demo/atlas/README.md', '# Atlas Studio\n\nUn espace client simple et accessible.'],
    ['/demo/atlas/src/components/ClientForm.tsx', 'export function ClientForm() { return <form aria-label="Demande client"><input aria-label="Votre demande" /></form>; }'],
    ['/demo/atlas/docs/delivery.md', '# Livraison\n\n- Revue de sécurité\n- Navigation clavier\n- Validation des contenus'],
    ['/demo/helio/README.md', '# Helio Data\n\nImport et contrôle de qualité des catalogues fournisseurs.'],
    ['/demo/helio/fixtures/catalog.csv', 'name,price,unit\nLampe,49.90,EUR\nSupport,12.00,EUR\n'],
    ['/demo/helio/src/validate.py', 'def validate(row):\n    return bool(row.get("sku")) and float(row["price"]) >= 0\n'],
    ['/demo/helio/docs/incident.md', '# Incident synthétique\n\nLatence p95 : 840 ms. Hypothèse à vérifier : expiration simultanée des entrées de cache.'],
    ['/demo/meridian/README.md', '# Meridian Commerce\n\nService client et suivi des commandes.'],
    ['/demo/meridian/fixtures/order.json', JSON.stringify({ id: '1042', total: 89, currency: 'EUR', status: 'delivered', customer: 'Client exemple' }, null, 2)],
    ['/demo/meridian/docs/refunds.md', '# Remboursements\n\nVérifier la commande et demander la validation du responsable avant de confirmer une décision.'],
  ]);
  const config: ConfigSnapshot = { schemaVersion: 1, effective: { settings: { language: 'fr', appearance: { theme: 'macro-dark' }, notifications: { inAppEnabled: true }, onboarding: { completed: true } }, providers: {}, tools: { mcpServers: { documentation: { enabled: true, name: 'Documentation', transport: { type: 'stdio', command: 'demo-docs' } } } }, skills: {}, agents: {}, git: {}, runtime: {} }, projectEffective: {}, documents: [], provenance: [], diagnostics: [], pendingRestartPaths: [] };
  let revision = 1;
  const document = (kind: ConfigDocumentKind): ConfigDocument => ({ kind, scope: { type: 'user' }, value: config.effective[kind] ?? {}, etag: String(revision), readOnly: false, invalid: false, filePath: `/demo/config/${kind}.json`, diagnostics: [] });
  const fileKey = (a: Args) => a.workspaceScope === 'metadata' ? `${string(a.workspacePath)}::${string(a.path)}` : string(a.path);
  const terminalTabs: TerminalTabDto[] = [];
  const activeStreams = new Map<string, ReturnType<typeof setTimeout>>();
  const seen = new Map<string, number>();
  const unsupported = new Set<string>();
  const summary = (p: typeof plans[number]) => ({ ...p, hasAgsdl: !!p.agsdl, nodeCount: Object.keys(JSON.parse(p.agsdl.source).flow?.steps ?? {}).length, chatMessageCount: messages.filter(m => m.conversation_id === p.conversationId).length });
  const state = () => ({ schemaVersion: 1, values: structuredClone(values) });
  const gitStatus = () => ({ branch: 'main', head_commit: null, staged_files: [], unstaged_files: [{ path: 'src/audio/player.ts', status: 'modified', staged: false }], untracked_files: [], conflicted_files: [], merge_in_progress: false, is_clean: false, has_origin: true, has_upstream: true, ahead: 0, behind: 0 });
  const branch = (name: string) => ({ name, is_current: name === 'main', is_remote: false, upstream: `origin/${name}`, ahead: 0, behind: 0 });
  const listFiles = (path: string) => {
    const prefix = path.replace(/\/$/, '') + '/';
    const entries = new Map();
    for (const [file, content] of files) {
      if (!file.startsWith(prefix))
        continue;
      const relative = file.slice(prefix.length);
      const name = relative.split('/')[0];
      entries.set(name, { name, path: prefix + name, relative_path: relative, kind: relative.includes('/') ? 'directory' : 'file', is_hidden: name.startsWith('.'), is_readonly: false, created: DEMO_DATE, size: content.length, modified: DEMO_DATE, language: file.endsWith('.ts') ? 'typescript' : null });
    }
    return [...entries.values()];
  };
  const invoke = async (command: string, args: Args = {}): Promise<unknown> => {
    seen.set(command, (seen.get(command) ?? 0) + 1);
    const request = object(args.request);
    switch (command) {
      case 'demo_blueprint_catalog': return plans.filter(plan => plan.agsdl.design?.kind === 'blueprint').map(plan => {
        const source = JSON.parse(plan.agsdl.source);
        return { id: plan.id, projectIds: [...plan.projectIds], title: plan.title, description: plan.description,
          fields: plan.agsdl.design?.requirements?.map(field => ({ id: field.id, label: field.label, value: field.value ?? '' })) ?? [{ id: 'model', label: 'Modèle des agents', value: 'Macro AI · Démo' }],
          agents: Object.entries(source.agents).map(([id, agent]) => ({ title: plan.agsdl.display?.cards?.[`/agents/${id}`]?.title ?? id, prompt: (agent as { prompt?: { value?: string }[] }).prompt?.map(part => part.value ?? '').join('\n') ?? '' })),
        } satisfies DemoBlueprint;
      });
      case 'demo_blueprint_uses': return structuredClone([...blueprintUses.values()]);
      case 'demo_blueprint_prepare': {
        if (!projects.some(project => project.id === args.projectId)) throw new Error('Choisissez un projet.');
        const catalog = await invoke('demo_blueprint_catalog') as DemoBlueprint[];
        const blueprint = catalog.find(item => item.id === args.blueprintId);
        if (!blueprint) throw new Error('Blueprint introuvable.');
        if (!blueprint.projectIds.includes(string(args.projectId))) throw new Error('Ce blueprint n’est pas rattaché au projet choisi.');
        const previous = blueprintUses.get(string(args.id));
        if (previous && previous.state !== 'prepared') throw new Error('Cette utilisation a déjà été lancée.');
        const use: DemoBlueprintUse = { id: previous?.id ?? (string(args.id) || crypto.randomUUID()), blueprint: structuredClone(blueprint), projectId: string(args.projectId), objective: string(args.objective), values: Object.fromEntries(Object.entries(object(args.values)).map(([key, value]) => [key, string(value)])), taskIds: [], state: 'prepared' };
        blueprintUses.set(use.id, use);
        return structuredClone(use);
      }
      case 'demo_blueprint_start': {
        const use = blueprintUses.get(string(args.id));
        if (!use) throw new Error('Préparation introuvable.');
        if (use.state !== 'prepared') return structuredClone(use);
        if (missingBlueprintFields(use.blueprint, use.objective, use.values).length) throw new Error('Complétez les champs nécessaires avant de lancer.');
        const created = blueprintAgentTasks(use);
        for (const task of created) {
          tasks.push(task);
          conversations.push({ ...structuredClone(demoConversations[3]), id: task.conversation_id!, title: task.title, scope_mode: 'Implement', project_id: use.projectId, task_id: task.id, message_count: 2 });
          messages.push(demoMessage(task.conversation_id!, 'user', `${use.objective}\n\n${use.blueprint.fields.map(field => `${field.label} : ${use.values[field.id] ?? field.value}`).join('\n')}`), demoMessage(task.conversation_id!, 'assistant', use.blueprint.agents[created.indexOf(task)].prompt + '\n\nExécution simulée en cours.'));
        }
        use.taskIds = created.map(task => task.id); use.state = 'running';
        return structuredClone(use);
      }
      case 'demo_blueprint_advance': {
        const use = blueprintUses.get(string(args.id));
        if (!use || use.state !== 'running') return use ? structuredClone(use) : null;
        const current = tasks.find(task => use.taskIds.includes(task.id) && task.status === 'InProgress');
        if (current) {
          current.status = 'Completed';
          messages.push(demoMessage(current.conversation_id!, 'assistant', `Contrôle terminé. Résultat fictif transmis à l’étape suivante. Aucun outil externe n’a été exécuté.`));
        }
        const next = tasks.find(task => use.taskIds.includes(task.id) && task.status === 'Blocked');
        if (next) { next.status = 'InProgress'; next.is_blocked = false; next.blocked_by_task_ids = []; }
        else use.state = 'completed';
        return structuredClone(use);
      }
      case 'execution_model_choices':return {revision:'demo-1',models:[{providerId:demoProvider.id,modelId:demoModel.model_id,providerName:demoProvider.name,modelName:demoModel.name,edition:macroNativeModelEdition(demoProvider.id,demoModel.model_id)}],unavailableProviders:[]};
      case 'execution_read_intents': return [];
      case 'execution_list_runs': return { runs: [], nextCursor: null };
      case 'frontend_log': return;
      case 'db_list_conversation_goal_audits':
      case 'db_list_unresolved_tool_invocations': return [];
      case 'tool_get_mode_policy': return { allowed_tool_ids: [], enforce_macro_only_writes: true, capabilities: [] };
      case 'repository_instructions_load': return { sources: [], issues: [], totalBytes: 0, fileLimit: 16, byteLimit: 65536 };
      case 'web_search_get_secret_status': return { provider: args.provider, hasSecret: false, secretRef: 'demo' };
      case 'plugin:app|version': return '0.0.0-demo';
      case 'window_maximize': return;
      case 'mcp_runtime_open_interaction_port': return 'demo-port';
      case 'mcp_runtime_close_interaction_port': return;
      case 'mcp_runtime_get_snapshot': return { generatedAt: DEMO_DATE, servers: [] };
      case 'speech_list_provider_configs': return [];
      case 'db_reconcile_project_registry': return { conversations_updated: 0, project_contexts_deleted: 0, project_contexts_updated: 0, session_context_updated: false };
      case 'window_is_maximized': return false;
      case 'window_outer_size': return { width: 1440, height: 900 };
      case 'window_outer_position': return { x: 0, y: 0 };
      case 'window_scale_factor': return 1;
      case 'window_set_zoom':
      case 'window_set_position':
      case 'window_set_size':
      case 'window_set_traffic_light_position':
      case 'show_main_window':
      case 'workspace_architect_invalidate': return;
      case 'terminal_list_tabs': return terminalTabs;
      case 'terminal_create_tab':
      case 'terminal_start_command_tab': {
        const p = projects.find(p => p.id === args.projectId) ?? projects[0];
        const tab: TerminalTabDto = { id: crypto.randomUUID(), kind: string(args.kind) || 'manual', task_id: string(args.taskId) || null, project_id: p.id, project_name: p.name, mount_name: p.mountName ?? p.id, workspace_path: p.path, cwd: string(args.cwd) || p.path, title: string(args.title) || 'Terminal démo', status: 'idle', snapshot: 'Mode démo : aucune commande système ne sera exécutée.\r\n$ ', last_command: null, last_exit_code: null, has_live_session: true, is_restored: false, output_sequence: 0, generation: 1, created_at: DEMO_DATE, updated_at: DEMO_DATE };
        terminalTabs.push(tab);
        return tab;
      }
      case 'terminal_read_tab':
      case 'terminal_reconnect_tab': return terminalTabs.find(t => t.id === args.tabId);
      case 'terminal_execute_command':
      case 'terminal_write_input': {
        const t = terminalTabs.find(t => t.id === args.tabId);
        if (t) {
          const cmd = string(args.command ?? args.data);
          t.last_command = cmd;
          t.snapshot += cmd + '\r\n[Simulation] Commande reçue. Aucun processus exécuté.\r\n$ ';
          t.output_sequence++;
          emit('terminal:output', { tab_id: t.id, data: t.snapshot, sequence: t.output_sequence });
        }
        return t;
      }
      case 'terminal_interrupt':
      case 'terminal_resize': return terminalTabs.find(t => t.id === args.tabId);
      case 'terminal_clear_tab': {
        const t = terminalTabs.find(t => t.id === args.tabId);
        if (t)
          t.snapshot = '$ ';
        return t;
      }
      case 'terminal_close_tab': {
        const i = terminalTabs.findIndex(t => t.id === args.tabId);
        if (i >= 0)
          terminalTabs.splice(i, 1);
        return;
      }
      case 'list_external_apps': return [];
      case 'app_update_status':
      case 'app_update_check_and_stage': return { currentVersion: '0.1.8', update: null };
      case 'updater_target': return 'darwin-aarch64';
      case 'git_worktree_inspect': return { taskId: args.taskId, worktreePath: '/demo/luma', branchName: args.branchName, status: 'ready', isDirty: false };
      case 'db_get_initialization_status':
      case 'db_retry_initialize': return { status: 'ready', message: null };
      case 'local_backup_status': return { browser: null };
      case 'config_get_snapshot':
      case 'config_list': return { ...structuredClone(config), documents: Object.keys(config.effective).map(k => document(k as ConfigDocumentKind)) };
      case 'config_get_document':
      case 'config_get':
      case 'config_reload': return document(args.kind as ConfigDocumentKind);
      case 'config_list_pending_changes':
      case 'config_list_orphan_secrets': return [];
      case 'config_validate_document':
      case 'config_validate': return { valid: true, diagnostics: [] };
      case 'config_get_schema': return { type: 'object', properties: {} };
      case 'config_apply_patch':
      case 'config_patch': {
        const kind = request.kind as ConfigDocumentKind;
        for (const op of (request.patch ?? []) as JsonPatchOperation[]) {
          const keys = op.path.split('/').slice(1).map(x => x.replaceAll('~1', '/').replaceAll('~0', '~'));
          if (keys.some(x => ['__proto__', 'constructor', 'prototype'].includes(x)))
            throw new Error('Invalid demo configuration path');
          let target = object(config.effective[kind]);
          config.effective[kind] = target;
          if (!keys.length) {
            config.effective[kind] = 'value' in op ? op.value : {};
            continue;
          }
          for (const k of keys.slice(0, -1)) {
            target[k] ??= {};
            target = object(target[k]);
          }
          if (op.op === 'remove')
            delete target[keys.at(-1)!];
          else if ('value' in op)
            target[keys.at(-1)!] = op.value;
        }
        revision++;
        emit('config:changed', {});
        return { status: 'applied', document: document(kind), pendingChange: null, restartRequired: false };
      }
      case 'state_get_snapshot': return state();
      case 'state_set_value':
        values[string(args.key)] = args.value;
        return state();
      case 'state_delete_value':
        delete values[string(args.key)];
        return state();
      case 'state_clear':
        Object.keys(values).forEach(k => delete values[k]);
        return state();
      case 'db_compare_and_swap_app_setting': {
        const k = string(args.key);
        const applied = (settings.get(k) ?? null) === (args.expectedValueJson ?? null);
        if (applied)
          settings.set(k, string(args.valueJson));
        return { applied };
      }
      case 'http_release_webview_resource': return;
      case 'db_upsert_architect_plan_conversation_sync':{const input=object(args.input);const row={...input,updated_at:DEMO_DATE};transcriptSync.set(string(input.conversation_id),row);return row;}
      case 'db_get_architect_plan_conversation_sync':return transcriptSync.get(string(args.conversationId))??null;
      case 'db_get_architect_plan_conversation_sync_for_plan':return [...transcriptSync.values()].find(r=>r.plan_id===args.planId&&r.target_branch===args.targetBranch)??null;
      case 'db_delete_conversation_toolbox_state':
      case 'db_delete_conversation_compaction_state': return;
      case 'db_get_setting': return settings.get(string(args.key)) ?? null;
      case 'db_set_setting':
        settings.set(string(args.key), string(args.value));
        return;
      case 'db_get_app_setting': return settings.has(string(args.key)) ? { key: args.key, value_json: settings.get(string(args.key)), updated_at: DEMO_DATE } : null;
      case 'db_set_app_setting':
        settings.set(string(args.key), string(args.valueJson));
        return { key: args.key, value_json: args.valueJson, updated_at: DEMO_DATE };
      case 'db_delete_app_setting': return settings.delete(string(args.key));
      case 'db_get_session_context_state': return structuredClone(sessionContext);
      case 'db_get_project_context_state': return structuredClone(projectContexts.get(string(args.projectId)) ?? null);
      case 'db_upsert_session_context_state':
        sessionContext = { ...sessionContext, ...object(args.input) };
        return structuredClone(sessionContext);
      case 'db_upsert_project_context_state': {
        const input = object(args.input);
        const id = string(input.project_id);
        const context = { ...projectContexts.get(id), ...input };
        projectContexts.set(id, context);
        return structuredClone(context);
      }
      case 'workspace_create_project': {
        const p = { ...structuredClone(demoProjects[0]), id: crypto.randomUUID(), name: string(args.name) || 'Nouveau projet', path: string(args.path) || '/demo/new-project' };
        p.metadata.description = string(args.description);
        projects.push(p);
        return p;
      }
      case 'workspace_remove_project': {
        const id = string(args.projectId);
        const i = projects.findIndex(p => p.id === id);
        if (i >= 0)
          projects.splice(i, 1);
        return [];
      }
      case 'workspace_update_project_access':
      case 'workspace_update_project_git_flow': return projects.find(p => p.id === args.projectId);
      case 'workspace_update_standalone_task_status': {
        const t = tasks.find(t => t.id === args.taskId);
        if (t)
          t.status = args.status as typeof t.status;
        return ++revision;
      }
      case 'workspace_delete_manual_feature': {
        const i = tasks.findIndex(t => t.id === args.taskId);
        if (i >= 0)
          tasks.splice(i, 1);
        return;
      }
      case 'workspace_get_bootstrap': return { plan: null, standaloneProjects: projects, projectGroups: [], planNodes: [], predictedBranches: [] };
      case 'workspace_list_projects': return [];
      case 'workspace_get_active_root': return '/demo';
      case 'workspace_get_metadata': return { workspace_path: '/demo', metadata_path: '/demo/.macro', project_count: projects.length };
      case 'workspace_resolve_project_icons': return [];
      case 'workspace_list_tasks': return { tasks, plans: [], hasStandaloneTasks: true, source: 'mixed' };
      case 'workspace_architect_list_plans':
        if (request.branchName !== 'main')
          return { activePlanId: null, plans: [], runtimeStatus: null };
        return { activePlanId: null, plans: plans.filter(p => !request.scopedProjectIdsHint || !(request.scopedProjectIdsHint as string[]).length || (request.scopedProjectIdsHint as string[]).includes(p.projectId)).map(summary), runtimeStatus: null };
      case 'workspace_architect_activate_plan_head': {
        const p = plans.find(p => p.id === request.planId);
        return p ? { plan: p, conversationId: p.conversationId, sharedConversation: false, targetBranch: 'main', replicaScopeKey: `project:${p.projectId}`, replicaProjectId: p.projectId, resolutionMode: 'canonical', chatTranscriptRevision: null, chatMessageCount: 2 } : null;
      }
      case 'workspace_architect_get_plan': return plans.find(p => p.id === (request.planId ?? args.planId)) ?? null;
      case 'workspace_architect_activate_plan_chat':
      case 'workspace_architect_get_plan_transcript': {
        const p = plans.find(p => p.id === request.planId);
        return { planId: p?.id, targetBranch: 'main', replicaScopeKey: `project:${p?.projectId}`, replicaProjectId: p?.projectId, transcriptRevision: null, messageCount: 2, messages: messages.filter(m => m.conversation_id === p?.conversationId).map(m => ({ ...m, createdAt: m.created_at })) };
      }
      case 'db_list_conversations': return conversations;
      case 'db_get_chat_snapshot': return { conversations, messages };
      case 'db_get_chat_bootstrap_snapshot': return { conversations, messages_by_conversation_id: Object.fromEntries(conversations.map(c => [c.id, messages.filter(m => m.conversation_id === c.id)])) };
      case 'db_list_messages': return messages.filter(m => m.conversation_id === args.conversationId);
      case 'db_get_conversation': return conversations.find(c => c.id === args.id) ?? null;
      case 'db_create_conversation': {
        const c: DbConversation = { ...structuredClone(demoConversations[3]), ...args, id: crypto.randomUUID(), title: string(args.title) || 'Nouvelle conversation', scope_mode: (args.scopeMode ?? 'Chat') as DbConversation['scope_mode'], project_id: string(args.projectId) || null, task_id: string(args.taskId) || null, message_count: 0 };
        conversations.unshift(c);
        return c;
      }
      case 'db_rename_conversation':
      case 'db_update_conversation_details': {
        const c = conversations.find(c => c.id === args.id);
        if (c)
          c.title = string(args.title);
        return;
      }
      case 'db_update_conversation_scope':
      case 'db_update_conversation_ai_selection': {
        const c = conversations.find(c => c.id === args.id);
        if (c) {
          if (args.providerId)
            c.provider_id = string(args.providerId);
          if (args.modelId)
            c.model_id = string(args.modelId);
        }
        return;
      }
      case 'db_toggle_pin_conversation': {
        const c = conversations.find(c => c.id === args.id);
        if (c)
          c.is_pinned = !c.is_pinned;
        return c?.is_pinned ?? false;
      }
      case 'db_delete_conversation_by_id':
      case 'db_delete_conversations_by_ids': {
        const ids = (args.ids ?? [args.id]) as string[];
        for (let i = conversations.length - 1; i >= 0; i--)
          if (ids.includes(conversations[i].id))
            conversations.splice(i, 1);
        return;
      }
      case 'db_create_message':
      case 'db_insert_message': {
        const input = object(args.params ?? args.input);
        const a = { ...args, ...input };
        const m = demoMessage(string(a.conversationId ?? a.conversation_id), string(a.role), string(a.content));
        if (typeof a.id === 'string')
          m.id = a.id;
        messages.push(m);
        return m;
      }
      case 'db_import_messages': {
        const imported = (args.messages as Args[]).map(m => ({ ...demoMessage(string(args.conversationId), string(m.role), string(m.content)), ...m, conversation_id: string(args.conversationId) }));
        messages.push(...imported);
        return imported;
      }
      case 'db_update_message': {
        const m = messages.find(m => m.id === args.id);
        if (m)
          m.content = string(args.content);
        return;
      }
      case 'db_get_conversation_compaction_state':
      case 'db_get_conversation_toolbox_state':
      case 'db_get_conversation_goal':
      case 'db_get_current_conversation_goal':
        return null;
      case 'db_list_conversation_citations':
      case 'db_list_tool_invocations':
      case 'db_list_recoverable_goal_audits': return [];
      case 'db_list_provider_configs': return [demoProvider];
      case 'db_list_provider_models':
      case 'ai_sync_provider_models': return [demoModel];
      case 'db_get_provider_settings': return { provider_id: args.providerId, filter_free_models: false, copilot_send_timeout_ms: null };
      case 'ai_get_dev_provider_overrides':
      case 'ai_load_dev_provider_overrides': return null;
      case 'ai_provision_macro_ai': return { status: 'ready', provider_id: 'demo-provider' };
      case 'ai_stream_chat': {
        const id = string(request.requestId ?? request.request_id);
        const text = 'Dans cette démonstration, je peux vous aider à explorer le système et les écrans de Macro. Les réponses sont simulées localement. Aucun fichier réel ni fournisseur IA n’est utilisé.';
        activeStreams.set(id, setTimeout(() => { activeStreams.delete(id); emit('ai:stream', { request_id: id, delta: text }); emit('ai:done', { request_id: id, output_text: text, visible_text: text, tool_calls: [], completion_reason: 'completed' }); }, 600));
        return;
      }
      case 'ai_cancel_stream': {
        const id = string(args.requestId);
        clearTimeout(activeStreams.get(id));
        activeStreams.delete(id);
        return;
      }
      case 'skills_list': return { skills: [demoSkill] };
      case 'skills_get': return { skill: demoSkill, body: 'Avant une publication, vérifie les tests, les changements et les installateurs. Présente les points qui demandent une décision. Dans cette démonstration, simule les résultats sans accéder à des fichiers réels.' };
      case 'skills_open_location': return;
      case 'macro_branch_ensure':
      case 'macro_branch_status':
      case 'macro_branch_commit_if_dirty':
      case 'macro_branch_push':
      case 'macro_branch_pull': return { branch: '@macro', state: 'synced', worktree_path: '/demo/.macro', is_dirty: false, has_origin: true, has_upstream: true, ahead: 0, behind: 0, conflicted_files: [], committed: false, commit_hash: null, reason: null, next_action: null, output: null, error: null };
      case 'git_status': return gitStatus();
      case 'git_branch_list': return { current: 'main', local: ['main', 'main', 'feature/audio-playback'].map(branch), remote: [] };
      case 'git_log': return [{ id: 'd3e0001', hash: 'd3e0001', short_hash: 'd3e0001', message: 'Améliorer la lecture audio', author: 'Équipe Luma', date: DEMO_DATE, parents: [] }];
      case 'git_log_page': return { commits: await invoke('git_log'), has_more: false, next_offset: null };
      case 'git_list_remotes': return [];
      case 'git_detect_gitflow': return { baseBranch: 'main', mainBranch: 'main', featurePrefix: 'feature/', releasePrefix: 'release/', hotfixPrefix: 'hotfix/', isGitRepo: true };
      case 'fs_read_file': {
        const path = string(args.path);
        const key = fileKey(args);
        const scopedPlans = plans.filter(p => path.startsWith('branches/main/') && (!args.workspacePath || projects.find(pr => pr.id === p.projectId)?.path === args.workspacePath));
        const plan = scopedPlans.find(p => path.endsWith(`/plans/${p.id}/plan.json`));
        if (plan && !files.has(key))
          files.set(key, JSON.stringify(plan));
        if (path.endsWith('/plans/index.json') && !files.has(key))
          files.set(key, JSON.stringify({ version: 3, activePlanId: scopedPlans[0]?.id ?? null, plans: scopedPlans.map(summary), reservedPlanSlugs: scopedPlans.map(p => p.slug) }));
        if (path.endsWith('/runtime.json') && !files.has(key))
          files.set(key, JSON.stringify({ schemaVersion: 1, planId: path.split('/').at(-2), updatedAt: DEMO_DATE, mergeWorkflows: {}, strategyPreview: null }));
        if (!files.has(key))
          throw new Error(`Fichier de démonstration introuvable : ${path}`);
        const content = files.get(key)!;
        return { content, encoding: 'utf-8', language: path.endsWith('.ts') ? 'typescript' : 'markdown', size: content.length, is_binary: false, revision: String(revision) };
      }
      case 'fs_write_file': {
        files.set(fileKey(args), string(args.content));
        revision++;
        if (string(args.path).endsWith('/plan.json')) {
          const incoming = JSON.parse(string(args.content));
          const p = plans.find(p => p.id === incoming.id);
          if (p)
            Object.assign(p, incoming);
          else
            plans.push(incoming);
        }
        return { path: args.path, bytes_written: string(args.content).length, revision: String(revision) };
      }
      case 'fs_delete': {
        const key = fileKey(args);
        for (const k of files.keys())
          if (k === key || (args.recursive && k.startsWith(key + '/')))
            files.delete(k);
        return;
      }
      case 'fs_create_dir': return;
      case 'fs_exists': return files.has(fileKey(args)) || listFiles(string(args.path)).length > 0;
      case 'fs_list_dir': return listFiles(string(args.path));
      case 'fs_stat': return { path: args.path, is_file: files.has(fileKey(args)), is_dir: !files.has(fileKey(args)), size: files.get(fileKey(args))?.length ?? 0, modified: DEMO_DATE };
      case 'mcp_list_servers':
      case 'mcp_list_tools': return [];
      case 'terminal_list':
      case 'terminal_list_sessions': return [];
      case 'plugin:http|fetch': {
        if (string(object(args.clientConfig).url) !== 'https://models.dev/api.json')
          throw new DemoUnsupportedCommand(command);
        return 1;
      }
      case 'plugin:http|fetch_send': return { status: 200, statusText: 'OK', url: 'https://models.dev/api.json', headers: [], rid: 1 };
      case 'plugin:http|fetch_read_body': return [1];
      case 'plugin:http|fetch_cancel':
      case 'plugin:http|fetch_cancel_body': return;
      case 'plugin:dialog|open': return '/demo/luma';
      case 'plugin:dialog|save': return '/demo/export.json';
      case 'plugin:os|platform': return 'linux';
      case 'plugin:os|type': return 'linux';
      case 'plugin:os|version': return 'Demo';
      case 'plugin:path|resolve_directory': return '/demo';
      case 'plugin:window|inner_size':
      case 'plugin:window|outer_size': return { width: 1280, height: 800 };
      case 'plugin:window|inner_position':
      case 'plugin:window|outer_position': return { x: 0, y: 0 };
      case 'plugin:window|scale_factor': return 1;
      case 'plugin:window|is_maximized':
      case 'plugin:window|is_fullscreen':
      case 'plugin:window|is_minimized': return false;
      case 'plugin:window|is_focused':
      case 'plugin:window|is_visible': return true;
      case 'plugin:window|available_monitors': return [];
      case 'plugin:window|current_monitor':
      case 'plugin:window|primary_monitor': return null;
      case 'plugin:webview|set_webview_zoom':
      case 'plugin:window|show':
      case 'plugin:window|set_focus':
      case 'plugin:window|set_size':
      case 'plugin:window|set_position':
      case 'plugin:window|set_background_color':
      case 'plugin:window|set_theme':
      case 'plugin:window|set_title':
      case 'plugin:window|start_dragging': return;
      case 'plugin:notification|is_permission_granted': return false;
      default:
        if (!unsupported.has(command))
          console.warn('[demo:unsupported]', command, JSON.stringify(args));
        unsupported.add(command);
        throw new DemoUnsupportedCommand(command);
    }
  };
  return { invoke, unsupported, seen, projects, tasks, plans, conversations, messages, files };
}
