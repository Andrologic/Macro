import { buildDemoExecutions, demoDesignNotes } from './executionScenarios';
import { DEMO_MACRO_LIBRARY_ID } from './macroBlueprintLibrary';
import { defaultLaunchRequirements } from './blueprintInputs';
import { buildQuestionnaireHiddenContextBlock } from '../services/chatQuestionnaires';
import type { PlanIcon } from '../services/planIcon';
import type { Project, Task, QuestionStep } from '../types';
import type { DbConversation, DbMessage, DbProviderConfig, DbAiModel } from '../services/tauriIpc';
import { demoPool, type DemoPoolEntry } from './agsdl/pool';
export const DEMO_ROOT = '/demo';
export const DEMO_DATE = '2026-01-15T10:00:00Z';
const projectSeeds = [
  { id: 'demo-luma', name: 'Luma Mobile', mount: 'luma', description: 'Notes vocales, transcription et synthèse de réunions.', tags: ['React Native', 'Audio', 'TypeScript'] },
  { id: 'demo-atlas', name: 'Atlas Studio', mount: 'atlas', description: 'Portail client et production éditoriale d’un studio créatif.', tags: ['React', 'Accessibilité', 'Contenu'] },
  { id: 'demo-helio', name: 'Helio Data', mount: 'helio', description: 'Import de données, contrôle de qualité et traitement des incidents.', tags: ['Python', 'Données', 'API'] },
  { id: 'demo-meridian', name: 'Meridian Commerce', mount: 'meridian', description: 'Commandes, service client et remboursements.', tags: ['TypeScript', 'Commerce', 'Support'] },
  { id: 'demo-empty', name: 'Nouveau projet', mount: 'new-project', description: 'Un projet sans blueprint local pour essayer la bibliothèque commune.', tags: [] },
];
export const demoProjects: Project[] = projectSeeds.map(seed => ({
  id: seed.id, name: seed.name, mountName: seed.mount, path: `/demo/${seed.mount}`,
  created_at: DEMO_DATE, status: 'active', gitSetupState: 'ready',
  metadata: { description: seed.description, tags: seed.tags, team_members: [], api_contracts: [], dependencies: [] },
}));
export const demoTasks: Task[] = [];
// Demo blueprints are AgSDL documents read from the pool, as a user would import them.
function poolPlan({ id, source, meta }: DemoPoolEntry) {
  const projectIds = [meta.projectId];
  return { icon: meta.icon as PlanIcon | undefined, id, slug: id, title: meta.title, label: meta.title, description: meta.description, planKind: meta.planKind, status: 'draft', targetBranch: 'main', projectId: meta.projectId, projectIds, contextProjectIds: [], conversationId: `${id}-chat`, createdAt: DEMO_DATE, updatedAt: DEMO_DATE, nodes: [], predictedBranches: [], expectedProjectIds: projectIds, availableProjectIds: projectIds, missingProjectIds: [], replicationState: 'complete', revision: 1, replicas: [], hasReplicaDivergence: false,
    agsdl: { source: JSON.stringify(source, null, 2), annexes: {} as Record<string, string>, design: meta.design, display: meta.display, revision: 1, updatedAt: DEMO_DATE } };
}
export const demoPlans = demoPool.map(poolPlan);
const releaseBlueprint = demoPlans.find(plan => plan.id === 'demo-release')!;
releaseBlueprint.agsdl.design = { ...releaseBlueprint.agsdl.design, requirements: defaultLaunchRequirements() };

// Common blueprints use normal plan persistence, graphs and conversations.
// Their synthetic workspace is presented separately from user projects.
demoProjects.push({ id: DEMO_MACRO_LIBRARY_ID, name: 'Macro', mountName: 'macro', path: '/demo/macro', created_at: DEMO_DATE, status: 'active', gitSetupState: 'ready', metadata: { description: 'Blueprints communs à tous les projets.', tags: [], team_members: [], api_contracts: [], dependencies: [] } });

const executionFixtures = buildDemoExecutions(demoPlans, DEMO_DATE);
demoTasks.push(...executionFixtures.tasks);
export const demoExecutionGraphs = executionFixtures.executions;
export const demoTaskReplies = executionFixtures.replies;

export const demoProvider: DbProviderConfig = { id: 'demo-provider', name: 'Macro AI · Démo', provider_type: 'openai', base_url: 'https://demo.invalid', api_key: null, has_stored_api_key: true, is_enabled: true, is_local: true, auth_status: 'authenticated', auth_source: null, plan_type: null, account_label: null, token_expires_at: null, created_at: DEMO_DATE, updated_at: DEMO_DATE };
export const demoModel: DbAiModel = { id: 'demo-model', provider_id: demoProvider.id, model_id: 'demo-model', name: 'Assistant simulé', description: 'Réponses locales de démonstration', owned_by: null, pricing_prompt: null, pricing_completion: null, pricing_request: null, reasoning_efforts: null, default_reasoning_effort: null, context_window_tokens: 128000, input_limit_tokens: 120000, output_limit_tokens: 8000, context_window_source: 'manual', context_limits_updated_at: DEMO_DATE, is_enabled: true, is_manual: true, first_seen_at: DEMO_DATE, last_seen_at: DEMO_DATE };
const conversationSeeds: Array<[string, string, DbConversation['scope_mode'], string, string | null]> = [
  ...demoPlans.map((plan): [string, string, DbConversation['scope_mode'], string, null] => [plan.conversationId, plan.title, 'Architect', plan.projectId, null]),
  ['demo-task-chat', 'Améliorer la lecture audio', 'Implement', 'demo-luma', 'demo-audio'],
  ...demoTasks.filter(task => task.conversation_id && task.id !== 'demo-audio').map((task): [string, string, DbConversation['scope_mode'], string, string] => [task.conversation_id!, task.title, 'Implement', task.project_id, task.id]),
  ['demo-chat', 'Idées pour Luma', 'Chat', 'demo-luma', null],
  ['demo-atlas-chat', 'Livraison du portail client', 'Chat', 'demo-atlas', null],
  ['demo-helio-chat', 'Qualité des données', 'Chat', 'demo-helio', null],
  ['demo-meridian-chat', 'Politique de remboursement', 'Chat', 'demo-meridian', null],
];
export const demoConversations: DbConversation[] = conversationSeeds.map(([id, title, scope_mode, project_id, task_id]) => ({
  id, title, scope_mode, project_id, task_id, group_id: null, description: null, provider_id: 'demo-provider', model_id: 'demo-model', reasoning_effort: null,
  created_at: DEMO_DATE, updated_at: DEMO_DATE, last_message: null, message_count: 2, is_pinned: id === 'demo-helio-chat',
}));
export function demoMessage(conversationId: string, role: string, content: string): DbMessage {
  return { id: crypto.randomUUID(), conversation_id: conversationId, role, content, created_at: DEMO_DATE, turn_id: null, token_count: null, tool_traces_json: null, hidden_context: null, provider_input_items_json: null, provider_turn_state_json: null, context_refs_json: null, completion_reason: role === 'assistant' ? 'completed' : null, generation_attempts_json: null };
}
export const demoMessages = [
  demoMessage('demo-release-chat', 'user', 'Préparons la release de Luma. Je voudrais relire les changements et vérifier les installateurs.'),
  demoMessage('demo-release-chat', 'assistant', 'Le blueprint décrit les vérifications de la release. Les données propres à chaque utilisation seront fournies dans Operate.\n\nLes instructions des agents sont modifiables depuis les blocs ou le chat.'),
  demoMessage('demo-assistant-chat', 'user', 'Créons un assistant pour les demandes des clients du studio.'),
  demoMessage('demo-assistant-chat', 'assistant', 'L’assistant clarifie la demande, prépare une réponse et vérifie sa cohérence. Nous pouvons ajuster les instructions ensemble.'),
  demoMessage('demo-task-chat', 'user', 'La lecture audio doit reprendre à la dernière position.'),
  demoMessage('demo-task-chat', 'assistant', 'La reprise est ajoutée dans `src/audio/player.ts`. Le contrôle final attend votre relecture de cette modification fictive.'),
  demoMessage('demo-chat', 'user', 'Quelles améliorations seraient utiles pour Luma ?'),
  demoMessage('demo-chat', 'assistant', 'Nous pouvons améliorer la reprise audio, simplifier les réglages et ajouter un assistant vocal. Par quoi souhaitez-vous commencer ?'),
];
for (const plan of demoPlans.slice(2)) {
  demoMessages.push(
    demoMessage(plan.conversationId, 'user', plan.description),
    demoMessage(plan.conversationId, 'assistant', demoDesignNotes[plan.id] ?? plan.description),
  );
}
for (const task of demoTasks.filter(task => task.conversation_id && task.id !== 'demo-audio')) {
  demoMessages.push(demoMessage(task.conversation_id!, 'user', task.description),
    demoMessage(task.conversation_id!, 'assistant', demoTaskReplies.get(task.id) ?? task.description));
}
const questionnaires: Array<{ taskId: string; questions: QuestionStep[] }> = [
  { taskId: 'demo-transcript', questions: [
    { id: 'first-name', prompt: 'Quel nom faut-il retenir à 04:12 ?', choices: ['Ana', 'Anna', 'Anah'], free_text_placeholder: 'Écrire le nom exact…' },
    { id: 'second-name', prompt: 'Quel nom faut-il retenir à 11:38 ?', choices: ['Maël', 'Gaël', 'Manuel'], free_text_placeholder: 'Écrire le nom exact…' },
  ] },
  { taskId: 'demo-writer-direction', questions: [
    { id: 'angle', prompt: 'Quel angle donner au dossier ?', choices: ['Exemples techniques', 'Usages métier', 'Les deux à parts égales'], free_text_placeholder: 'Préciser l’angle…' },
  ] },
];
for (const entry of questionnaires) {
  const task = demoTasks.find(task => task.id === entry.taskId)!;
  const message = demoMessages.slice().reverse().find(message => message.conversation_id === task.conversation_id && message.role === 'assistant')!;
  message.hidden_context = buildQuestionnaireHiddenContextBlock({ source: 'tool', questions: entry.questions });
}

const projectChats: Array<[string, string, string]> = [
  ['demo-atlas-chat', 'Quels points devons-nous vérifier avant de livrer le portail ?', 'La revue avant livraison répartit les contrôles entre sécurité, accessibilité et contenu. Une synthèse précède la validation du responsable. Le dossier éditorial illustre une autre forme de travail parallèle.'],
  ['demo-helio-chat', 'Pourquoi l’import du catalogue est-il bloqué ?', 'Douze lignes du fichier fournisseur manquent de références SKU. La normalisation est terminée, mais la correction ne peut pas inventer ces références. Le scénario Import de catalogue montre le chemin de contrôle et le traitement des anomalies.'],
  ['demo-meridian-chat', 'Dans quels cas demander une validation humaine ?', 'Une validation du responsable intervient avant le remboursement. Le client reçoit ensuite une réponse adaptée à la décision. La branche alternative permet de proposer un échange.'],
];
for (const [id, question, answer] of projectChats) demoMessages.push(demoMessage(id, 'user', question), demoMessage(id, 'assistant', answer));
for (const conversation of demoConversations) {
  const messages = demoMessages.filter(message => message.conversation_id === conversation.id);
  conversation.message_count = messages.length;
  conversation.last_message = messages.at(-1)?.content ?? null;
}

export const demoSkill = {
  id: 'demo-review', name: 'release-review', description: 'Vérifier les prérequis avant une publication.', license: 'AGPL-3.0-or-later', compatibility: null, allowedTools: null, metadata: {},
  rootPath: '/demo/skills/release-review', skillFilePath: '/demo/skills/release-review/SKILL.md', location: { kind: 'local', uri: '/demo/skills/release-review' },
  source: { kind: 'user', namespace: 'demo', rootId: 'demo-skills', priority: 1, projectId: null, projectName: null, rootPath: '/demo/skills', skillRootPath: '/demo/skills/release-review' },
  resources: [], scripts: [], diagnostics: [], specCompliant: true, shadowedBySkillId: null, contentHash: 'demo-review-1', validationErrors: [], isValid: true,
};
