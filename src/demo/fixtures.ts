import { DEMO_MACRO_LIBRARY_ID } from './macroBlueprintLibrary';
import { sharedDemoBlueprints } from './sharedBlueprints';
import { defaultLaunchRequirements } from './blueprintInputs';
import type { Project, Task } from '../types';
import type { DbConversation, DbMessage, DbProviderConfig, DbAiModel } from '../services/tauriIpc';
import { createExampleDocument } from '../services/agsdl/examples';
export const DEMO_ROOT = '/demo';
export const DEMO_DATE = '2026-01-15T10:00:00Z';
const projectSeeds = [
  { id: 'demo-luma', name: 'Luma Mobile', mount: 'luma', description: 'Notes vocales, transcription et synthèse de réunions.', tags: ['React Native', 'Audio', 'TypeScript'] },
  { id: 'demo-atlas', name: 'Atlas Studio', mount: 'atlas', description: 'Portail client et production éditoriale d’un studio créatif.', tags: ['React', 'Accessibilité', 'Contenu'] },
  { id: 'demo-helio', name: 'Helio Data', mount: 'helio', description: 'Import de données, contrôle de qualité et traitement des incidents.', tags: ['Python', 'Données', 'API'] },
  { id: 'demo-meridian', name: 'Meridian Commerce', mount: 'meridian', description: 'Commandes, service client et remboursements.', tags: ['TypeScript', 'Commerce', 'Support'] },
];
export const demoProjects: Project[] = projectSeeds.map(seed => ({
  id: seed.id, name: seed.name, mountName: seed.mount, path: `/demo/${seed.mount}`,
  created_at: DEMO_DATE, status: 'active', gitSetupState: 'ready',
  metadata: { description: seed.description, tags: seed.tags, team_members: [], api_contracts: [], dependencies: [] },
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
type DemoAgent = { title: string; prompt: string; group?: string };
function scenario(id: string, title: string, projectId: string, description: string, agents: Record<string, DemoAgent>, entry: string, steps: Record<string, Record<string, unknown>>, labels: Record<string, string> = {}) {
  const plan = demoPlan(id, title, projectId, 'feature');
  const source = JSON.parse(plan.agsdl.source);
  source.id = id;
  source.agents = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, {
    configuration: 'project', prompt: [{ value: agent.prompt }, { ref: 'projectGuidance' }],
    interface: { results: { report: { mediaTypes: ['text/plain'], required: true } } },
  }]));
  source.flow = { entry, steps };
  source.bindings.knowledge = { contract: { identity: 'demo/knowledge', version: '1' }, implementation: { identity: 'demo/local-fixtures', version: '1' } };
  source.configurations.project.tools = { documentation: 'knowledge' };
  source.content.projectGuidance.value = `${description} Données fictives uniquement. Aucune action réelle.`;
  plan.description = description;
  plan.agsdl.source = JSON.stringify(source, null, 2);
  plan.agsdl.display = { title, cards: Object.fromEntries([
    ...Object.entries(agents).map(([name, agent]) => [`/agents/${name}`, { title: agent.title, ...(agent.group ? { macroGroup: agent.group } : {}) }]),
    ...Object.entries(steps).map(([name, step]) => [`/flow/steps/${name}`, { title: labels[name] ?? agents[String(step.agent)]?.title ?? name }]),
  ]) };
  return plan;
}
const agentStep = (agent: string, ...next: string[]) => ({ type: 'agent', agent, next });
const relay = (...next: string[]) => ({ type: 'prepare', message: { resources: { report: { source: { path: ['results', 'report'] } } } }, next });
const condition = (value: string, yes: string[], no: string[]) => ({ type: 'condition', test: { equals: [{ path: ['text'] }, { value }] }, next: { true: yes, false: no } });

export const demoPlans = [
  demoPlan('demo-release', 'Release mobile', 'demo-luma', 'release'),
  demoPlan('demo-assistant', 'Assistant client', 'demo-atlas', 'feature'),
  scenario('demo-voice', 'Compte rendu vocal', 'demo-luma', 'Transformer une réunion en compte rendu, avec une vérification des passages ambigus.', {
    transcribe: { title: 'Transcrire la réunion', prompt: 'Transcrire l’enregistrement. Marquer les passages incertains et identifier les interlocuteurs.' },
    clarify: { title: 'Clarifier les passages ambigus', prompt: 'Demander à la personne qui a fourni l’audio de préciser les passages ambigus. Conserver les incertitudes non résolues.' },
    summarize: { title: 'Rédiger le compte rendu', prompt: 'Produire un résumé structuré : décisions, responsables et échéances. Ne pas inventer de décisions.' },
    review: { title: 'Vérifier la fidélité', prompt: 'Comparer le compte rendu à la transcription et signaler les omissions.' },
  }, 'transcribe', {
    transcribe: agentStep('transcribe', 'confidence'), confidence: condition('À clarifier', ['clarify'], ['prepare']),
    clarify: agentStep('clarify', 'prepare'), prepare: relay('summarize'), summarize: agentStep('summarize', 'handoff'), handoff: relay('review'), review: agentStep('review'),
  }, { confidence: 'Passages incertains ?', prepare: 'Préparer la transcription', handoff: 'Transmettre le compte rendu' }),
  scenario('demo-quality', 'Revue avant livraison', 'demo-atlas', 'Croiser une revue de sécurité, d’accessibilité et de contenu avant de demander une validation humaine.', {
    scope: { title: 'Définir le périmètre', prompt: 'Identifier les pages modifiées et les critères de livraison.' },
    security: { title: 'Auditer la sécurité', prompt: 'Examiner les accès, les formulaires et l’exposition des données. Classer les constats par gravité.', group: 'Contrôles indépendants' },
    accessibility: { title: 'Tester l’accessibilité', prompt: 'Contrôler le clavier, les libellés, les contrastes et les messages d’erreur.', group: 'Contrôles indépendants' },
    content: { title: 'Relire le contenu', prompt: 'Vérifier les textes, les liens et les informations du portail client.', group: 'Contrôles indépendants' },
    synthesize: { title: 'Synthétiser les contrôles', prompt: 'Rassembler les trois rapports. Distinguer les blocages des améliorations facultatives.' },
    revise: { title: 'Préparer les corrections', prompt: 'Décrire les corrections demandées par le responsable de livraison.' },
  }, 'scope', {
    scope: agentStep('scope', 'fork'), fork: relay('security', 'accessibility', 'content'),
    security: agentStep('security', 'join'), accessibility: agentStep('accessibility', 'join'), content: agentStep('content', 'join'),
    join: { type: 'join', after: 'fork', members: ['security', 'accessibility', 'content'], next: ['synthesize'] },
    synthesize: agentStep('synthesize', 'approval'),
    approval: { type: 'approval', call: 'deliver', binding: 'knowledge', timeoutMs: 3600000, validForMs: 3600000, next: { approved: ['deliver'], denied: ['revise'] } },
    deliver: { type: 'call', binding: 'knowledge', scope: { action: 'deliver', resources: ['demo:delivery'], context: { value: 'Dossier fictif' } } }, revise: agentStep('revise'),
  }, { fork: 'Distribuer les contrôles', join: 'Rassembler les rapports', approval: 'Valider la livraison', deliver: 'Livrer le dossier' }),
  scenario('demo-ingestion', 'Import de catalogue', 'demo-helio', 'Importer un catalogue fournisseur, isoler les lignes invalides et produire un bilan exploitable.', {
    inspect: { title: 'Analyser le fichier', prompt: 'Détecter les colonnes, le séparateur et les champs obligatoires. Signaler les changements de format.' },
    normalize: { title: 'Normaliser les données', prompt: 'Uniformiser les unités, les dates et les identifiants. Préserver les valeurs originales dans le rapport.' },
    repair: { title: 'Traiter les anomalies', prompt: 'Expliquer les lignes rejetées et proposer une correction. Ne pas supprimer silencieusement les doublons.' },
    report: { title: 'Présenter le bilan', prompt: 'Présenter le nombre de lignes acceptées, rejetées et modifiées, avec des exemples.' },
  }, 'inspect', {
    inspect: agentStep('inspect', 'prepare'), prepare: relay('normalize'), normalize: agentStep('normalize', 'validate'),
    validate: { type: 'call', binding: 'knowledge', next: ['valid'], onError: ['repair'] },
    valid: condition('Valide', ['store'], ['repair']), repair: agentStep('repair', 'handoff'),
    store: { type: 'call', binding: 'knowledge', next: ['handoff'] }, handoff: relay('report'), report: agentStep('report'),
  }, { prepare: 'Préparer les lignes', validate: 'Contrôler le schéma', valid: 'Catalogue conforme ?', store: 'Enregistrer le catalogue', handoff: 'Transmettre les statistiques' }),
  scenario('demo-incident', 'Diagnostic d’incident', 'demo-helio', 'Rechercher la cause d’une latence anormale, puis vérifier une hypothèse avant de conclure.', {
    triage: { title: 'Qualifier l’incident', prompt: 'Délimiter la période, les utilisateurs concernés et les symptômes observés.' },
    investigate: { title: 'Examiner les traces', prompt: 'Comparer les traces avec les métriques. Présenter une hypothèse vérifiable, sans la confondre avec un fait.' },
    verify: { title: 'Tester l’hypothèse', prompt: 'Vérifier l’hypothèse contre les traces. Répondre Confirmée uniquement avec une preuve.' },
    conclude: { title: 'Rédiger le post-mortem', prompt: 'Résumer la cause, l’impact et les mesures de prévention.' },
  }, 'triage', {
    triage: agentStep('triage', 'collect'), collect: { type: 'call', binding: 'knowledge', next: ['investigate'] },
    investigate: agentStep('investigate', 'handoff'), handoff: relay('verify'), verify: agentStep('verify', 'confirmed'),
    confirmed: condition('Confirmée', ['conclude'], ['investigate']), conclude: agentStep('conclude'),
  }, { collect: 'Collecter les métriques', handoff: 'Transmettre l’hypothèse', confirmed: 'Hypothèse confirmée ?' }),
  scenario('demo-refund', 'Remboursement accompagné', 'demo-meridian', 'Vérifier une demande de remboursement et demander un accord avant toute décision.', {
    understand: { title: 'Comprendre la demande', prompt: 'Identifier la commande, le motif et la solution souhaitée. Demander les informations manquantes.' },
    eligibility: { title: 'Vérifier l’éligibilité', prompt: 'Comparer la commande à la politique de remboursement. Expliquer les exceptions.' },
    alternative: { title: 'Proposer une alternative', prompt: 'Proposer un échange ou une prise en charge adaptée, sans promettre une action non autorisée.' },
    notify: { title: 'Informer le client', prompt: 'Présenter la décision avec empathie, le délai attendu et les prochaines étapes.' },
  }, 'understand', {
    understand: agentStep('understand', 'lookup'), lookup: { type: 'call', binding: 'knowledge', next: ['eligibility'] },
    eligibility: agentStep('eligibility', 'eligible'), eligible: condition('Éligible', ['approval'], ['alternative']),
    approval: { type: 'approval', call: 'refund', binding: 'knowledge', timeoutMs: 3600000, validForMs: 3600000, next: { approved: ['refund'], denied: ['alternative'] } },
    refund: { type: 'call', binding: 'knowledge', scope: { action: 'refund', resources: ['demo:order-1042'], context: { value: 'Commande fictive de 89 €' } }, next: ['notify'] }, alternative: agentStep('alternative', 'notify'), notify: agentStep('notify'),
  }, { lookup: 'Consulter la commande', eligible: 'Remboursement possible ?', approval: 'Accord du responsable', refund: 'Préparer le remboursement' }),
  scenario('demo-editorial', 'Dossier éditorial', 'demo-atlas', 'Préparer un dossier avec une recherche documentaire et deux angles de rédaction en parallèle.', {
    research: { title: 'Rechercher les sources', prompt: 'Rassembler des sources vérifiables et distinguer les faits des interprétations.' },
    technical: { title: 'Rédiger l’angle technique', prompt: 'Expliquer le sujet avec des exemples précis et les limites de la solution.' },
    practical: { title: 'Rédiger le guide pratique', prompt: 'Présenter les étapes et les questions courantes du lecteur.' },
    edit: { title: 'Harmoniser le dossier', prompt: 'Assembler les deux contributions, supprimer les répétitions et vérifier les sources.' },
  }, 'research', {
    research: agentStep('research', 'fork'), fork: relay('technical', 'practical'),
    technical: agentStep('technical', 'join'), practical: agentStep('practical', 'join'),
    join: { type: 'join', after: 'fork', members: ['technical', 'practical'], next: ['edit'] }, edit: agentStep('edit'),
  }, { fork: 'Partager les sources', join: 'Assembler les contributions' }),
];

const advancedDelivery = scenario('demo-delivery', 'Livraison multi-plateforme', 'demo-luma', 'Réutiliser le même contrôle qualité pour le web et le mobile, puis autoriser une livraison avec un périmètre précis.', {
  coordinator: { title: 'Préparer la livraison', prompt: 'Identifier les versions web et mobile et leurs critères de validation.' },
  webReviewer: { title: 'Spécialiste web', prompt: 'Vérifier le paquet web et produire un rapport structuré avec les preuves.' },
  mobileReviewer: { title: 'Spécialiste mobile', prompt: 'Vérifier les paquets mobiles et les contraintes de distribution.' },
  coordinatorReview: { title: 'Consolider les preuves', prompt: 'Comparer les rapports web et mobile avant de demander l’accord de publication.' },
  repair: { title: 'Préparer une nouvelle version', prompt: 'Rassembler les constats qui empêchent la livraison. Préparer une nouvelle proposition.' },
}, 'coordinator', {
  coordinator: agentStep('coordinator', 'web'),
  web: { type: 'compose', composition: 'packageReview', agents: { specialist: 'webReviewer' }, next: { ready: ['mobile'], blocked: ['repair'] } },
  mobile: { type: 'compose', composition: 'packageReview', agents: { specialist: 'mobileReviewer' }, next: { ready: ['coordinatorReview'], blocked: ['repair'] } },
  coordinatorReview: agentStep('coordinatorReview', 'approval'),
  approval: { type: 'approval', binding: 'knowledge', call: 'publish', timeoutMs: 3600000, validForMs: 300000, next: { approved: ['publish'], denied: ['repair'] } },
  publish: { type: 'call', binding: 'knowledge', scope: { action: 'publish', resources: ['demo:release-2'], context: { value: { release: '2.0.0', targets: ['web', 'mobile'] } } } },
  repair: agentStep('repair'),
}, { web: 'Contrôler la version web', mobile: 'Contrôler la version mobile', approval: 'Autoriser la publication', publish: 'Publier la version validée' });
{
  const source = JSON.parse(advancedDelivery.agsdl.source);
  source.compositions = {
    evidenceReview: { agentParameters: ['reviewer'], entry: 'review', outputs: ['pass', 'fail'], steps: {
      review: { type: 'agent', agent: { parameter: 'reviewer' }, next: ['check'] },
      check: { type: 'condition', test: { equals: [{ path: ['results', 'report', 'value', 'approved'] }, { value: true }] }, next: { true: [{ output: 'pass' }], false: [{ output: 'fail' }] } },
    } },
    packageReview: { agentParameters: ['specialist'], entry: 'prepare', outputs: ['ready', 'blocked'], steps: {
      prepare: { type: 'prepare', message: { prompt: [{ ref: 'reviewInstructions' }], resources: { criteria: { ref: 'criteria' } } }, next: ['audit'] },
      audit: { type: 'agent', agent: { parameter: 'specialist' }, next: ['check'] },
      check: { type: 'condition', test: { equals: [{ path: ['results', 'report', 'value', 'approved'] }, { value: true }] }, next: { true: [{ output: 'ready' }], false: [{ output: 'blocked' }] } },
    } },
  };
  source.flow.steps.coordinatorReview = { type: 'compose', composition: 'evidenceReview', agents: { reviewer: 'coordinatorReview' }, next: { pass: ['approval'], fail: ['repair'] } };
  source.content.criteria = { value: { required: ['signature', 'version', 'smoke-tests'], targets: ['web', 'mobile'] }, mediaType: 'application/json' };
  source.content.reviewInstructions = { value: 'Évaluer chaque critère et joindre une preuve à chaque conclusion.' };
  source.content.sampleReport = { value: { approved: true, findings: [], evidence: ['Signature valide', 'Tests de démarrage réussis'] }, mediaType: 'application/json' };
  advancedDelivery.agsdl.source = JSON.stringify(source, null, 2);
  for (const [path, title] of Object.entries({
    '/compositions/packageReview/steps/prepare': 'Préparer les critères', '/compositions/packageReview/steps/audit': 'Examiner le paquet', '/compositions/packageReview/steps/check': 'Paquet conforme ?',
    '/compositions/evidenceReview/steps/review': 'Examiner les preuves', '/compositions/evidenceReview/steps/check': 'Critères satisfaits ?',
  })) advancedDelivery.agsdl.display!.cards![path] = { title };
}
const persistentWriter = scenario('demo-persistent', 'Rédaction supervisée', 'demo-atlas', 'Un agent de rédaction conserve son contexte. Un observateur lui transmet des consignes pendant le travail, puis une revue peut demander une nouvelle passe.', {
  writer: { title: 'Rédacteur persistant', prompt: 'Rédiger le dossier en conservant les décisions éditoriales entre les messages. Intégrer les consignes reçues pendant la rédaction.' },
  observer: { title: 'Observateur éditorial', prompt: 'Vérifier l’angle et les sources. Transmettre une consigne courte au rédacteur si le dossier s’éloigne de la demande.' },
  reviewer: { title: 'Relecteur indépendant', prompt: 'Comparer le dossier au brief. Répondre Prêt lorsque les critères sont satisfaits, sinon formuler une demande de révision.' },
}, 'start', {
  start: { type: 'prepare', message: { prompt: [{ ref: 'projectGuidance' }] }, next: ['write', 'observe'] },
  write: agentStep('writer', 'review'), observe: agentStep('observer', 'advice'),
  advice: { type: 'prepare', message: { prompt: [{ value: 'Intégrer la consigne de l’observateur.' }], resources: { guidance: { select: { path: ['text'] }, mediaType: 'text/plain' } } }, next: ['steer'] },
  steer: { type: 'agent', agent: 'writer', delivery: 'steering', steers: 'write' },
  review: { ...agentStep('reviewer', 'ready'), maxVisits: 3 },
  ready: condition('Prêt', ['finish'], ['revise']),
  revise: { ...agentStep('writer', 'review'), maxVisits: 2 }, finish: { type: 'prepare', message: { resources: { dossier: { select: { path: ['text'] }, mediaType: 'text/plain' } } } },
}, { start: 'Lancer la rédaction supervisée', write: 'Rédiger le dossier', observe: 'Observer le travail', advice: 'Préparer une consigne', steer: 'Réorienter le rédacteur', review: 'Relire le dossier', ready: 'Dossier prêt ?', revise: 'Reprendre avec le même agent', finish: 'Conserver le dossier' });
const residentTeam = scenario('demo-resident', 'Équipe support permanente', 'demo-meridian', 'Trois agents persistants reçoivent des messages à la demande. Ce système n’impose aucun ordre d’exécution.', {
  concierge: { title: 'Accueil client', prompt: 'Clarifier la demande et identifier le bon interlocuteur. Conserver l’historique des échanges avec le client.' },
  orders: { title: 'Spécialiste commandes', prompt: 'Expliquer l’état d’une commande à partir des ressources fournies. Demander les références manquantes.' },
  policy: { title: 'Référent politique commerciale', prompt: 'Expliquer la politique commerciale applicable et les cas qui demandent une décision humaine.' },
}, 'concierge', { concierge: agentStep('concierge') });
{
  const source = JSON.parse(residentTeam.agsdl.source);
  delete source.flow;
  residentTeam.agsdl.source = JSON.stringify(source, null, 2);
}
const competition = scenario('demo-competition', 'Recherche en compétition', 'demo-helio', 'Deux analystes cherchent en parallèle. Le premier résultat étayé est retenu ; les autres travaux sont arrêtés et leur fin est confirmée avant la synthèse.', {
  direct: { title: 'Analyste des métriques', prompt: 'Chercher une cause dans les métriques. Produire report avec approved, hypothesis et evidence. approved vaut true uniquement si une preuve étaye l’hypothèse.' },
  traces: { title: 'Analyste des traces', prompt: 'Chercher une cause dans les traces. Produire report avec approved, hypothesis et evidence. approved vaut true uniquement si une preuve étaye l’hypothèse.' },
  summarize: { title: 'Présenter la piste retenue', prompt: 'Présenter le résultat retenu sous members, ses preuves et les vérifications encore nécessaires.' },
  fallback: { title: 'Demander de nouvelles preuves', prompt: 'Expliquer pourquoi aucune piste n’a pu être retenue. Demander les données nécessaires à une nouvelle recherche.' },
}, 'fork', {
  fork: { type: 'prepare', message: { prompt: [{ value: 'Rechercher une hypothèse étayée sur la latence du catalogue.' }], resources: { mode: { ref: 'mode' } } }, next: ['metrics', 'traces'] },
  metrics: agentStep('direct', 'winner'), traces: agentStep('traces', 'winner'),
  winner: { type: 'join', after: 'fork', members: ['metrics', 'traces'], mode: 'first', accept: { equals: [{ path: ['results', 'report', 'value', 'approved'] }, { value: true }] }, remaining: 'stop-and-wait', next: ['summarize'], onError: ['fallback'] },
  summarize: agentStep('summarize'), fallback: agentStep('fallback'),
}, { fork: 'Lancer les deux recherches', metrics: 'Examiner les métriques', traces: 'Examiner les traces', winner: 'Retenir la première piste étayée' });
const structured = scenario('demo-structured', 'Extraction avec correction', 'demo-helio', 'Extraire une fiche produit structurée. Une sortie non conforme revient au même agent avec les erreurs ; une panne technique prend un autre chemin.', {
  extractor: { title: 'Extraire la fiche produit', prompt: 'Produire le résultat report en application/json : sku textuel, price numérique et currency parmi EUR ou USD. Ne pas ajouter d’autres propriétés. Si outputErrors est fourni, corriger la sortie en conservant le contexte.' },
  recovery: { title: 'Examiner le blocage', prompt: 'Présenter l’erreur technique ou la limite de correction atteinte. Indiquer ce qu’il faut vérifier avant une nouvelle tentative.' },
  publish: { title: 'Présenter la fiche validée', prompt: 'Présenter la fiche produit fournie dans product. Sa structure a été contrôlée ; ne pas affirmer que ses données commerciales ont été vérifiées.' },
}, 'extract', {
  extract: { ...agentStep('extractor', 'handoff'), maxVisits: 3, onError: ['correctable'] },
  correctable: { type: 'condition', test: { equals: [{ path: ['error', 'code'] }, { value: 'OUTPUT_CONSTRAINT' }] }, next: { true: ['feedback'], false: ['recovery'] } },
  feedback: { type: 'prepare', message: { prompt: [{ value: 'Corriger le résultat report selon les erreurs de validation jointes.' }], resources: { outputErrors: { select: { path: ['error'] }, mediaType: 'application/json' } } }, next: ['extract'] },
  handoff: { type: 'prepare', message: { resources: { product: { source: { path: ['results', 'report'] } } } }, next: ['publish'] },
  publish: agentStep('publish'), recovery: agentStep('recovery'),
}, { extract: 'Extraire la fiche produit', correctable: 'Erreur de format corrigeable ?', feedback: 'Transmettre les erreurs', handoff: 'Transmettre la fiche validée' });
const approvals = scenario('demo-approvals', 'Publication à double accord', 'demo-atlas', 'Capturer une publication précise, obtenir l’accord éditorial puis juridique, et publier seulement si les deux autorisations sont encore valides.', {
  prepare: { title: 'Préparer la publication', prompt: 'Préparer le dossier à publier avec sa version et son périmètre. Les accords portent sur cette publication précise.' },
  revise: { title: 'Revoir la proposition', prompt: 'Prendre en compte le refus. Préparer une nouvelle proposition sans réutiliser les autorisations précédentes.' },
  recover: { title: 'Examiner l’interruption', prompt: 'Expliquer l’échec de validation ou de publication. Vérifier les effets avant de proposer une nouvelle tentative.' },
  confirm: { title: 'Présenter le résultat', prompt: 'Présenter le résultat de la publication et sa référence. Mentionner les vérifications restantes.' },
}, 'prepare', {
  prepare: agentStep('prepare', 'editorial'),
  editorial: { type: 'approval', call: 'publish', binding: 'editorialApproval', timeoutMs: 600000, validForMs: 900000, next: { approved: ['legal'], denied: ['revise'] }, onError: ['recover'] },
  legal: { type: 'approval', call: 'publish', binding: 'legalApproval', timeoutMs: 300000, validForMs: 300000, next: { approved: ['publish'], denied: ['revise'] }, onError: ['recover'] },
  publish: { type: 'call', binding: 'publication', arguments: { dossier: { path: ['text'] } }, scope: { action: 'publish', resources: ['demo:editorial-release'], context: { path: ['text'] } }, next: ['confirm'], onError: ['recover'] },
  revise: agentStep('revise'), recover: agentStep('recover'), confirm: agentStep('confirm'),
}, { editorial: 'Accord éditorial', legal: 'Accord juridique', publish: 'Publier le dossier autorisé' });
{
  const source = JSON.parse(approvals.agsdl.source);
  for (const [name, contract, effects] of [['editorialApproval', 'editorial-approval', 'none'], ['legalApproval', 'legal-approval', 'none'], ['publication', 'publication', 'external']]) source.bindings[name] = {
    contract: { identity: `demo/${contract}`, version: '1' }, implementation: { identity: 'demo/local-fixtures', version: '1' }, effects,
  };
  approvals.agsdl.source = JSON.stringify(source, null, 2);
}
demoPlans.push(advancedDelivery, persistentWriter, residentTeam, competition, structured, approvals);

const crisis = scenario('demo-crisis', 'Cellule de crise', 'demo-helio', 'Croiser trois analyses, retenir la première piste étayée, choisir une réponse, faire approuver l’intervention puis comparer les contrôles techniques et métier. Les sous-processus conservent leurs agents et leurs sorties propres.', {
  metrics: { title: 'Expert métriques', prompt: 'Chercher une cause dans les métriques. Produire report JSON avec approved, hypothesis et evidence. approved doit être étayé par des preuves.' },
  traces: { title: 'Expert traces', prompt: 'Chercher une cause dans les traces. Produire report JSON avec approved, hypothesis et evidence.' },
  customer: { title: 'Expert parcours client', prompt: 'Examiner les parcours affectés. Produire report JSON avec approved, hypothesis et evidence.' },
  lead: { title: 'Responsable de crise', prompt: 'Examiner la piste sous members et choisir intervenir, observer ou escalader selon le risque et les preuves.' },
  planner: { title: 'Concepteur de l’intervention', prompt: 'Préparer une intervention réversible. Produire report JSON avec approved, hypothesis et evidence.' },
  observer: { title: 'Analyste de surveillance', prompt: 'Évaluer la surveillance nécessaire. Produire report JSON avec approved, hypothesis et evidence.' },
  technical: { title: 'Contrôle technique', prompt: 'Vérifier la latence et les erreurs après la décision. Produire report JSON avec approved, hypothesis et evidence.' },
  business: { title: 'Contrôle métier', prompt: 'Vérifier les commandes et les parcours clients. Produire report JSON avec approved, hypothesis et evidence.' },
  reviewer: { title: 'Auditeur des preuves', prompt: 'Comparer toutes les preuves transmises. Produire report JSON avec approved, hypothesis et evidence.' },
  report: { title: 'Rapport de clôture', prompt: 'Présenter les faits, les décisions, les effets observés et les points à suivre.' },
  escalation: { title: 'Coordination humaine', prompt: 'Expliquer le refus ou les preuves manquantes. Préparer les questions à trancher sans lancer d’intervention.' },
  recovery: { title: 'Examiner l’échec technique', prompt: 'Identifier la frontière qui a échoué. Vérifier les effets réels avant toute nouvelle tentative.' },
}, 'launch', {
  launch: { type: 'prepare', message: { prompt: [{ value: 'Incident catalogue : identifier une piste étayée et préserver les commandes.' }], resources: { mode: { ref: 'mode' }, incident: { ref: 'incident' } } }, next: ['metrics', 'traces', 'customer'] },
  metrics: agentStep('metrics', 'first'), traces: agentStep('traces', 'first'), customer: agentStep('customer', 'first'),
  first: { type: 'join', after: 'launch', members: ['metrics', 'traces', 'customer'], mode: 'first', accept: { equals: [{ path: ['results', 'report', 'value', 'approved'] }, { value: true }] }, remaining: 'finish', next: ['decide'], onError: ['recovery'] },
  decide: { type: 'agent', agent: 'lead', decision: { binding: 'decision', choices: ['intervenir', 'observer', 'escalader'] }, next: { intervenir: ['intervention'], observer: ['observation'], escalader: ['escalation'] } },
  intervention: { type: 'compose', composition: 'assessment', agents: { specialist: 'planner' }, next: { ready: ['operationsApproval'], revise: ['escalation'] }, onError: ['recovery'] },
  observation: { type: 'compose', composition: 'assessment', agents: { specialist: 'observer' }, next: { ready: ['watch'], revise: ['escalation'] }, onError: ['recovery'] },
  operationsApproval: { type: 'approval', call: 'deploy', binding: 'operationsApproval', timeoutMs: 600000, validForMs: 900000, next: { approved: ['securityApproval'], denied: ['escalation'] }, onError: ['recovery'] },
  securityApproval: { type: 'approval', call: 'deploy', binding: 'securityApproval', timeoutMs: 300000, validForMs: 300000, next: { approved: ['deploy'], denied: ['escalation'] }, onError: ['recovery'] },
  deploy: { type: 'call', binding: 'deployment', arguments: { assessment: { path: ['results', 'report', 'value'] } }, scope: { action: 'deploy', resources: ['demo:catalog-service'], context: { path: [] } }, next: ['watch'], onError: ['recovery'] },
  watch: { type: 'prepare', message: { prompt: [{ value: 'Contrôler les indicateurs techniques et les parcours métier.' }], resources: { observation: { select: { path: [] }, mediaType: 'application/json' } } }, next: ['technical', 'business'] },
  technical: agentStep('technical', 'all'), business: agentStep('business', 'all'),
  all: { type: 'join', after: 'watch', members: ['technical', 'business'], mode: 'all', next: ['evidence'], onError: ['recovery'] },
  evidence: { type: 'prepare', message: { resources: { technical: { source: { path: ['members', 'technical', 'results', 'report'] } }, business: { source: { path: ['members', 'business', 'results', 'report'] } } }, prompt: [{ value: 'Auditer les deux contrôles joints et statuer sur la clôture.' }] }, next: ['closure'] },
  closure: { type: 'compose', composition: 'assessment', agents: { specialist: 'reviewer' }, next: { ready: ['report'], revise: ['escalation'] }, onError: ['recovery'] },
  report: agentStep('report'), escalation: agentStep('escalation'), recovery: agentStep('recovery'),
}, { launch: 'Ouvrir les trois investigations', metrics: 'Analyser les métriques', traces: 'Analyser les traces', customer: 'Analyser les parcours', first: 'Première piste étayée', decide: 'Choisir la réponse', intervention: 'Préparer une intervention', observation: 'Évaluer la surveillance', operationsApproval: 'Accord opérations', securityApproval: 'Accord sécurité', deploy: 'Intervenir sur le service', watch: 'Déclencher les contrôles', technical: 'Vérifier les indicateurs', business: 'Vérifier les commandes', all: 'Attendre les deux contrôles', evidence: 'Rassembler les preuves', closure: 'Auditer la clôture' });
{
  const source = JSON.parse(crisis.agsdl.source);
  const binding = (name: string, effects = 'none') => ({ contract: { identity: `demo/${name}`, version: '1' }, implementation: { identity: 'demo/local-fixtures', version: '1' }, effects });
  source.bindings.decision = binding('crisis-decision');
  source.bindings.operationsApproval = binding('operations-approval');
  source.bindings.securityApproval = binding('security-approval');
  source.bindings.deployment = binding('deployment', 'external');
  source.content.incident = { value: { service: 'catalog', latencyP95: 840, failedOrders: 17, targetP95: 250 }, mediaType: 'application/json' };
  source.compositions = { assessment: { agentParameters: ['specialist'], entry: 'review', outputs: ['ready', 'revise'], steps: {
    review: { type: 'agent', agent: { parameter: 'specialist' }, next: ['check'], onError: [{ error: true }], maxVisits: 2 },
    check: { type: 'condition', test: { all: [{ equals: [{ path: ['results', 'report', 'value', 'approved'] }, { value: true }] }, { not: { equals: [{ path: ['results', 'report', 'value', 'hypothesis'] }, { value: '' }] } }] }, next: { true: [{ output: 'ready' }], false: [{ output: 'revise' }] }, onError: [{ error: true }] },
  } } };
  for (const [group, members] of Object.entries({ 'Investigation concurrente': ['launch', 'metrics', 'traces', 'customer', 'first'], 'Intervention autorisée': ['intervention', 'operationsApproval', 'securityApproval', 'deploy'], 'Contrôles croisés': ['watch', 'technical', 'business', 'all', 'evidence', 'closure'] })) {
    for (const name of members) crisis.agsdl.display!.cards![`/flow/steps/${name}`].macroGroup = group;
  }
  crisis.agsdl.source = JSON.stringify(source, null, 2);
  for (const [path, title] of Object.entries({ '/compositions/assessment': 'Expertise paramétrée', '/compositions/assessment/steps/review': 'Mobiliser le spécialiste', '/compositions/assessment/steps/check': 'Preuves suffisantes ?', '/bindings/operationsApproval': 'Opérations', '/bindings/securityApproval': 'Sécurité', '/bindings/deployment': 'Déploiement' })) crisis.agsdl.display!.cards![path] = { title };
}
demoPlans.push(crisis);

// Shared content and capability declarations remain part of the real AgSDL documents.
for (const plan of demoPlans.slice(2)) {
  const source = JSON.parse(plan.agsdl.source);
  source.content.policy = { value: 'Conserver les preuves et signaler les informations manquantes avant de conclure.' };
  source.content.reference = { uri: 'demo://documents/reference.pdf', mediaType: 'application/pdf' };
  source.content.mode = { value: 'thorough', mediaType: 'text/plain' };
  source.skills = { evidence: { prompt: [{ ref: 'policy' }], resources: { reference: { ref: 'reference' } } } };
  source.configurations.fast = { engine: 'engine', tools: { documentation: 'knowledge' }, settings: { temperature: 0.2 } };
  source.configurations.thorough = { engine: 'engine', tools: { documentation: 'knowledge' }, settings: { temperature: 0 } };
  for (const agent of Object.values(source.agents) as Array<Record<string, unknown>>) {
    agent.skills = ['evidence'];
    agent.resources = { brief: { ref: 'projectGuidance' }, mode: { ref: 'mode' } };
  }
  const selectable = source.agents[Object.keys(source.agents)[0]];
  selectable.configuration = { select: { path: ['resources', 'mode', 'value'] }, cases: { fast: 'fast', thorough: 'thorough' } };
  if (plan.id === 'demo-delivery') for (const name of ['webReviewer', 'mobileReviewer', 'coordinatorReview']) source.agents[name].interface.results.report = {
    mediaTypes: ['application/json'], required: true,
  };
  if (plan.id === 'demo-crisis') {
    const report = { mediaTypes: ['application/json'], required: true, valueSchema: { type: 'object', properties: { approved: { type: 'boolean' }, hypothesis: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['approved', 'hypothesis', 'evidence'], additionalProperties: false } };
    for (const name of ['metrics', 'traces', 'customer', 'planner', 'observer', 'technical', 'business', 'reviewer']) source.agents[name].interface.results.report = report;
    source.skills.diagnosis = { prompt: [{ value: 'Séparer les observations des hypothèses et joindre les mesures qui les étayent.' }] };
    source.skills.risk = { prompt: [{ value: 'Examiner la réversibilité et l’impact sur les commandes avant toute intervention.' }] };
    source.skills.reporting = { prompt: [{ value: 'Présenter les décisions et les preuves dans un compte rendu concis.' }] };
    for (const name of ['metrics', 'traces', 'customer']) source.agents[name].skills.push('diagnosis');
    source.agents.planner.skills.push('risk');
    source.agents.reviewer.skills.push('risk');
    source.agents.report.skills.push('reporting');
    for (const [name, title] of Object.entries({ evidence: 'Preuves', diagnosis: 'Diagnostic', risk: 'Analyse des risques', reporting: 'Compte rendu' })) plan.agsdl.display!.cards![`/skills/${name}`] = { title };
  }
  if (plan.id === 'demo-competition') for (const name of ['direct', 'traces']) source.agents[name].interface.results.report = {
    mediaTypes: ['application/json'], required: true, valueSchema: { type: 'object', properties: { approved: { type: 'boolean' }, hypothesis: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['approved', 'hypothesis', 'evidence'], additionalProperties: false },
  };
  if (plan.id === 'demo-structured') source.agents.extractor.interface.results.report = {
    mediaTypes: ['application/json'], required: true, valueSchema: { type: 'object', properties: { sku: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string', enum: ['EUR', 'USD'] } }, required: ['sku', 'price', 'currency'], additionalProperties: false },
  };
  if (plan.id === 'demo-incident') {
    source.bindings.classification = { contract: { identity: 'demo/decision', version: '1' }, implementation: { identity: 'demo/classifier', version: '1' }, effects: 'none' };
    source.flow.steps.triage.decision = { binding: 'classification', choices: ['investigate', 'escalate'] };
    source.flow.steps.triage.next = { investigate: ['collect'], escalate: ['conclude'] };
    source.flow.steps.investigate.maxVisits = 3;
    source.flow.steps.verify.maxVisits = 3;
    source.flow.steps.collect.arguments = { interval: { value: '15m' }, service: { value: 'catalog-api' } };
  }
  plan.agsdl.display!.cards!['/flow'] = { title: plan.title };
  if (plan.id === 'demo-delivery') {
    plan.agsdl.display!.cards!['/compositions/evidenceReview'] = { title: 'Contrôle des preuves' };
    plan.agsdl.display!.cards!['/compositions/packageReview'] = { title: 'Contrôle d’un paquet' };
  }
  plan.agsdl.design = { ...plan.agsdl.design!, purpose: plan.description, context: 'Jeu de données fictives pour explorer les capacités AgSDL.' };
  plan.agsdl.source = JSON.stringify(source, null, 2);
}

for (const plan of demoPlans.filter(plan => ['demo-voice', 'demo-quality', 'demo-ingestion', 'demo-refund'].includes(plan.id))) {
  plan.agsdl.design = { ...plan.agsdl.design!, kind: 'blueprint', requirements: [{ id: 'model', label: 'Modèle des agents', description: 'Choix pour cette utilisation simulée', value: 'Macro AI · Démo' }] };
}
const releaseBlueprint = demoPlans.find(plan => plan.id === 'demo-release')!;
releaseBlueprint.agsdl.design = { ...releaseBlueprint.agsdl.design!, kind: 'blueprint', requirements: defaultLaunchRequirements() };

// Common blueprints use normal plan persistence, graphs and conversations.
// Their synthetic workspace is presented separately from user projects.
demoProjects.push({ id: DEMO_MACRO_LIBRARY_ID, name: 'Macro', mountName: 'macro', path: '/demo/macro', created_at: DEMO_DATE, status: 'active', gitSetupState: 'ready', metadata: { description: 'Blueprints communs à tous les projets.', tags: [], team_members: [], api_contracts: [], dependencies: [] } });
for (const blueprint of sharedDemoBlueprints) {
  const agents = Object.fromEntries(blueprint.agents.map((agent, index) => [`agent${index + 1}`, agent]));
  const steps = Object.fromEntries(blueprint.agents.map((_, index) => [`agent${index + 1}`, agentStep(`agent${index + 1}`, ...(index + 1 < blueprint.agents.length ? [`agent${index + 2}`] : []))]));
  const plan = scenario(blueprint.id, blueprint.title, DEMO_MACRO_LIBRARY_ID, blueprint.description || (blueprint.awaitsInput ? 'Un assistant qui attend votre demande.' : 'Préparer, réaliser et vérifier un chantier.'), agents, 'agent1', steps);
  plan.agsdl.design = { ...plan.agsdl.design!, kind: 'blueprint', requirements: [] };
  demoPlans.push(plan);
}

const taskSeeds: Array<[string, string, string, string, Task['status'], string]> = [
  ['demo-transcript', 'demo-luma', 'demo-voice', 'Clarifier deux passages de la réunion', 'AwaitingResponse', 'Les noms de deux participants sont ambigus. Confirmer leur orthographe avant la synthèse.'],
  ['demo-summary', 'demo-luma', 'demo-voice', 'Préparer le résumé de la réunion', 'Blocked', 'En attente des précisions sur la transcription.'],
  ['demo-installers', 'demo-luma', 'demo-release', 'Comparer les paquets de la release', 'InReview', 'Les paquets iOS et Android ont été contrôlés. Relire le bilan avant publication.'],
  ['demo-security', 'demo-atlas', 'demo-quality', 'Vérifier les accès au portail', 'Completed', 'Les routes privées refusent les sessions expirées. Aucun blocage dans ce scénario.'],
  ['demo-keyboard', 'demo-atlas', 'demo-quality', 'Corriger le focus du formulaire', 'InProgress', 'Le focus doit revenir sur le premier champ invalide après une erreur.'],
  ['demo-copy', 'demo-atlas', 'demo-editorial', 'Relire le guide de démarrage', 'Pending', 'Harmoniser les titres et vérifier les exemples.'],
  ['demo-catalog', 'demo-helio', 'demo-ingestion', 'Contrôler les données fournisseur', 'Failed', 'Le fichier ne contient pas la colonne SKU. Une reprise avec un fichier corrigé est nécessaire.'],
  ['demo-deduplicate', 'demo-helio', 'demo-ingestion', 'Examiner les doublons du catalogue', 'InReview', 'Douze références ont des variantes proches. Choisir les enregistrements à conserver.'],
  ['demo-latency', 'demo-helio', 'demo-incident', 'Analyser la hausse de latence', 'InProgress', 'L’analyse compare le cache, les accès base de données et les requêtes lentes.'],
  ['demo-postmortem', 'demo-helio', 'demo-incident', 'Préparer le compte rendu d’incident', 'Blocked', 'La cause doit être confirmée avant de rédiger les mesures préventives.'],
  ['demo-refund-review', 'demo-meridian', 'demo-refund', 'Valider la demande de remboursement', 'AwaitingResponse', 'Le montant est de 89 €. Le dossier attend la décision du responsable.'],
  ['demo-order-mail', 'demo-meridian', 'demo-refund', 'Préparer la réponse au client', 'Completed', 'Le brouillon précise le délai de traitement et les prochaines étapes.'],
];
demoTasks.push(...taskSeeds.map(([id, project_id, plan_id, title, status, description]): Task => ({
  id, project_id, plan_id, title, status, description, dependencies: id === 'demo-summary' ? ['demo-transcript'] : id === 'demo-postmortem' ? ['demo-latency'] : [],
  estimated_changes: [], task_kind: 'feature', standalone_kind: 'manual_feature', task_source: 'standalone',
  conversation_id: `${id}-chat`, assigned_branch: `feature/${id.replace('demo-', '')}`, branch_name: `feature/${id.replace('demo-', '')}`,
  is_blocked: status === 'Blocked', is_ready: status === 'Pending',
})));
demoTasks.push({
  id: 'demo-archived-guide', project_id: 'demo-atlas', plan_id: 'demo-editorial',
  title: 'Relire l’ancien guide', description: 'Relecture terminée. Cette tâche est conservée dans les archives.',
  status: 'Completed', dependencies: [], estimated_changes: [], task_kind: 'feature',
  standalone_kind: 'manual_feature', task_source: 'standalone', conversation_id: 'demo-archived-guide-chat',
  archived_at: DEMO_DATE,
});
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
  demoMessage('demo-release-chat', 'assistant', 'Le blueprint décrit les vérifications de la release. Les données propres à chaque utilisation seront fournies dans Operate.\n\nAu-dessus du graphe, « Préparer le blueprint » permet de choisir ce qui sera demandé au lancement. Les instructions des agents restent modifiables depuis les blocs ou le chat.'),
  demoMessage('demo-assistant-chat', 'user', 'Créons un assistant pour les demandes des clients du studio.'),
  demoMessage('demo-assistant-chat', 'assistant', 'L’assistant clarifie la demande, prépare une réponse et vérifie sa cohérence. Nous pouvons ajuster les instructions ensemble.'),
  demoMessage('demo-task-chat', 'user', 'La lecture audio doit reprendre à la dernière position.'),
  demoMessage('demo-task-chat', 'assistant', 'J’ai préparé une modification de `src/audio/player.ts`. Vous pouvez consulter les changements dans le panneau de droite. Les fichiers et les résultats présentés ici sont fictifs.'),
  demoMessage('demo-chat', 'user', 'Quelles améliorations seraient utiles pour Luma ?'),
  demoMessage('demo-chat', 'assistant', 'Nous pouvons améliorer la reprise audio, simplifier les réglages et ajouter un assistant vocal. Par quoi souhaitez-vous commencer ?'),
];
for (const plan of demoPlans.slice(2)) {
  demoMessages.push(
    demoMessage(plan.conversationId, 'user', plan.description),
    demoMessage(plan.conversationId, 'assistant', `Le graphe est prêt à être exploré.

${plan.description}

Sélectionnez un bloc pour suivre ses échanges. Ouvrez ses détails pour lire les instructions et voir les outils déclarés.`),
  );
}
for (const task of demoTasks.filter(task => task.conversation_id && task.id !== 'demo-audio')) {
  const waiting = task.status === 'AwaitingResponse';
  demoMessages.push(demoMessage(task.conversation_id!, 'user', task.description), demoMessage(task.conversation_id!, 'assistant',
    waiting ? `${task.description}

J’attends votre réponse pour poursuivre. Les informations de ce dossier sont fictives.`
      : task.status === 'Failed' ? `Le contrôle a détecté un problème.

${task.description}

Aucune modification n’a été appliquée. On peut examiner le fichier puis préparer une reprise.`
      : task.status === 'Blocked' ? `Cette étape attend la tâche précédente.

${task.description}`
      : `${task.description}

Le résultat de cette étape est disponible pour relecture dans ce scénario de démonstration.`));
}
const projectChats: Array<[string, string, string]> = [
  ['demo-atlas-chat', 'Quels points devons-nous vérifier avant de livrer le portail ?', 'La revue avant livraison répartit les contrôles entre sécurité, accessibilité et contenu. Une synthèse précède la validation du responsable. Le dossier éditorial illustre une autre forme de travail parallèle.'],
  ['demo-helio-chat', 'Pourquoi l’import du catalogue est-il bloqué ?', 'Le fichier fournisseur manque de références SKU. Douze autres lignes présentent des doublons. Le scénario Import de catalogue montre le chemin de contrôle et le traitement des anomalies.'],
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
