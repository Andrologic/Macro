import type { Project, Task } from '../types';
import type { DbConversation, DbMessage, DbProviderConfig, DbAiModel } from '../services/tauriIpc';
import { createExampleDocument } from '../services/agsdl/examples';
export const DEMO_ROOT = '/demo';
export const DEMO_DATE = '2026-01-15T10:00:00Z';
export const demoProjects: Project[] = ['Luma Mobile', 'Atlas Studio'].map((name, i) => ({
  id: i ? 'demo-atlas' : 'demo-luma', name, mountName: i ? 'atlas' : 'luma', path: `/demo/${i ? 'atlas' : 'luma'}`,
  created_at: DEMO_DATE, status: 'active', gitSetupState: 'ready',
  metadata: { description: i ? 'Site et espace client du studio.' : 'Application de notes et de conversations vocales.', tags: ['React', 'TypeScript'], team_members: [], api_contracts: [], dependencies: [] },
}));
export const demoTasks: Task[] = [
  { id: 'demo-audio', plan_id: 'demo-release', project_id: 'demo-luma', title: 'Améliorer la lecture audio', description: 'Conserver la position de lecture et afficher un état de chargement clair.', status: 'Pending', dependencies: [], estimated_changes: [{ path: 'src/audio/player.ts', operation: 'Modify', diff_preview: 'Lecture asynchrone et reprise de position.' }], task_kind: 'feature', standalone_kind: 'manual_feature', conversation_id: 'demo-task-chat', assigned_branch: 'feature/audio-playback', branch_name: 'feature/audio-playback', task_source: 'standalone', is_ready: true },
  { id: 'demo-accessibility', plan_id: 'demo-release', project_id: 'demo-luma', title: 'Vérifier l’accessibilité', description: 'Contrôler le contraste et la navigation clavier.', status: 'Completed', dependencies: [], estimated_changes: [], task_kind: 'bugfix', standalone_kind: 'manual_feature', assigned_branch: 'bugfix/accessibility', branch_name: 'bugfix/accessibility', task_source: 'standalone' },
];
export function demoPlan(id: string, title: string, projectId: string, kind: 'release' | 'feature') {
  const document = createExampleDocument(kind);
  const labels = kind === 'release' ? ['Vérifier les prérequis', 'Relire les changements', 'Vérifier les installateurs'] : ['Comprendre la demande', 'Préparer la réponse', 'Vérifier le résultat'];
  const parsed = JSON.parse(document.source);
  const agentIds = Object.keys(parsed.agents);
  agentIds.forEach((agent, index) => {
    parsed.agents[agent].prompt = [{ value: `${labels[index]}. Consignez le résultat et les points qui demandent une décision.` }];
    document.display!.cards![`/agents/${agent}`] = { title: labels[index] };
    document.display!.cards![`/flow/steps/${agent}`] = { title: labels[index] };
  });
  for (const [stepId, step] of Object.entries(parsed.flow.steps) as [string, {type:string}][]) {
    if (step.type === 'prepare') document.display!.cards![`/flow/steps/${stepId}`] = {title: 'Transmettre le rapport'};
  }
  parsed.content.projectGuidance.value = 'Projet fictif. Les actions et résultats sont simulés dans le mode démo.';
  return { id, slug: id, title, label: title, description: kind === 'release' ? 'Préparer une publication de Luma sans oublier les vérifications.' : 'Concevoir un assistant pour le studio.', planKind: kind, status: 'draft', targetBranch: 'main', projectId, projectIds: [projectId], contextProjectIds: [], conversationId: `${id}-chat`, createdAt: DEMO_DATE, updatedAt: DEMO_DATE, nodes: [], predictedBranches: [], expectedProjectIds: [projectId], availableProjectIds: [projectId], missingProjectIds: [], replicationState: 'complete', revision: 1, replicas: [], hasReplicaDivergence: false, agsdl: { ...document, source: JSON.stringify(parsed, null, 2), revision: 1, updatedAt: DEMO_DATE, display: { ...document.display, title } } };
}
export const demoPlans = [demoPlan('demo-release', 'Release mobile', 'demo-luma', 'release'), demoPlan('demo-assistant', 'Assistant client', 'demo-atlas', 'feature')];
export const demoProvider: DbProviderConfig = { id: 'demo-provider', name: 'Macro AI · Démo', provider_type: 'openai', base_url: 'https://demo.invalid', api_key: null, has_stored_api_key: true, is_enabled: true, is_local: true, auth_status: 'authenticated', auth_source: null, plan_type: null, account_label: null, token_expires_at: null, created_at: DEMO_DATE, updated_at: DEMO_DATE };
export const demoModel: DbAiModel = { id: 'demo-model', provider_id: demoProvider.id, model_id: 'demo-model', name: 'Assistant simulé', description: 'Réponses locales de démonstration', owned_by: null, pricing_prompt: null, pricing_completion: null, pricing_request: null, reasoning_efforts: null, default_reasoning_effort: null, context_window_tokens: 128000, input_limit_tokens: 120000, output_limit_tokens: 8000, context_window_source: 'manual', context_limits_updated_at: DEMO_DATE, is_enabled: true, is_manual: true, first_seen_at: DEMO_DATE, last_seen_at: DEMO_DATE };
export const demoConversations: DbConversation[] = [
  ['demo-release-chat', 'Release mobile', 'Architect', 'demo-luma', null], ['demo-assistant-chat', 'Assistant client', 'Architect', 'demo-atlas', null],
  ['demo-task-chat', 'Améliorer la lecture audio', 'Implement', 'demo-luma', 'demo-audio'], ['demo-chat', 'Idées pour Luma', 'Chat', 'demo-luma', null],
].map(([id, title, scope_mode, project_id, task_id]) => ({ id: id!, title: title!, scope_mode: scope_mode as DbConversation['scope_mode'], project_id, task_id, group_id: null, description: null, provider_id: 'demo-provider', model_id: 'demo-model', reasoning_effort: null, created_at: DEMO_DATE, updated_at: DEMO_DATE, last_message: null, message_count: 2, is_pinned: false }));
export function demoMessage(conversationId: string, role: string, content: string): DbMessage {
  return { id: crypto.randomUUID(), conversation_id: conversationId, role, content, created_at: DEMO_DATE, turn_id: null, token_count: null, tool_traces_json: null, hidden_context: null, provider_input_items_json: null, provider_turn_state_json: null, context_refs_json: null, completion_reason: role === 'assistant' ? 'completed' : null, generation_attempts_json: null };
}
export const demoMessages = [
  demoMessage('demo-release-chat', 'user', 'Préparons la release de Luma. Je voudrais relire les changements et vérifier les installateurs.'),
  demoMessage('demo-release-chat', 'assistant', 'Le système est prêt à être exploré.\n\nLes agents vérifient les prérequis, relisent les changements puis contrôlent les installateurs. Cliquez sur une étape du graphe pour consulter ses instructions.\n\nDans ce mode démo, vous pouvez modifier les informations sans toucher à vos projets.'),
  demoMessage('demo-assistant-chat', 'user', 'Créons un assistant pour les demandes des clients du studio.'),
  demoMessage('demo-assistant-chat', 'assistant', 'L’assistant clarifie la demande, prépare une réponse et vérifie sa cohérence. Nous pouvons ajuster les instructions ensemble.'),
  demoMessage('demo-task-chat', 'user', 'La lecture audio doit reprendre à la dernière position.'),
  demoMessage('demo-task-chat', 'assistant', 'J’ai préparé une modification de `src/audio/player.ts`. Vous pouvez consulter les changements dans le panneau de droite. Les fichiers et les résultats présentés ici sont fictifs.'),
  demoMessage('demo-chat', 'user', 'Quelles améliorations seraient utiles pour Luma ?'),
  demoMessage('demo-chat', 'assistant', 'Nous pouvons améliorer la reprise audio, simplifier les réglages et ajouter un assistant vocal. Par quoi souhaitez-vous commencer ?'),
];
export const demoSkill = {
  id: 'demo-review', name: 'release-review', description: 'Vérifier les prérequis avant une publication.', license: 'AGPL-3.0-or-later', compatibility: null, allowedTools: null, metadata: {},
  rootPath: '/demo/skills/release-review', skillFilePath: '/demo/skills/release-review/SKILL.md', location: { kind: 'local', uri: '/demo/skills/release-review' },
  source: { kind: 'user', namespace: 'demo', rootId: 'demo-skills', priority: 1, projectId: null, projectName: null, rootPath: '/demo/skills', skillRootPath: '/demo/skills/release-review' },
  resources: [], scripts: [], diagnostics: [], specCompliant: true, shadowedBySkillId: null, contentHash: 'demo-review-1', validationErrors: [], isValid: true,
};
