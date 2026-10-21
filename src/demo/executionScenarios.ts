import type { Task, TaskStatus } from '../types';
import type { AgsdlEditorDocument } from '../types/agsdl';
import type { TaskExecutionGraph } from '../services/taskExecutionGraph';
import type { DemoWorkflowStep } from './blueprintLaunch';
import { projectViewer } from '../services/agsdl/viewer';
import { object, text } from '../services/agsdl/document';

interface Plan { id: string; projectId: string; title: string; agsdl: AgsdlEditorDocument }
interface SceneTask {
  id: string;
  path: string;
  status: TaskStatus;
  description: string;
  reply: string;
  after: string[];
  interaction?: 'question' | 'approval';
  reviewAfter?: boolean;
  finishAfter?: string[];
}
interface Scene { label?: string; failedSteps?: string[]; id: string; planId: string; projectId?: string; archived?: boolean; tasks: SceneTask[]; completedSteps?: string[] }
const step = (id: string, path: string, status: TaskStatus, description: string, reply: string, after: string[] = [], extra: Pick<SceneTask, 'interaction' | 'reviewAfter' | 'finishAfter'> = {}): SceneTask => ({ id, path: path.startsWith('/') ? path : `/flow/steps/${path}`, status, description, reply, after, ...extra });

/** Chosen, authored demo routes. These scenes are examples, not an AgSDL interpreter. */
export const demoExecutionScenes: Scene[] = [
  { id: 'audio', planId: 'demo-audio-feature', tasks: [
    step('demo-audio-scope', 'scope', 'Completed', 'La reprise doit conserver la dernière position.', 'Le besoin est confirmé : reprendre après une pause, un changement d’écran et un chargement lent.'),
    step('demo-audio', 'implement', 'InReview', 'Relire la modification du lecteur audio.', 'La reprise est ajoutée dans src/audio/player.ts. Votre relecture précède le contrôle final.', ['demo-audio-scope'], { reviewAfter: true }),
    step('demo-audio-check', 'verify', 'Blocked', 'Vérifier la reprise après la modification.', 'Les contrôles attendent la modification du lecteur.', ['demo-audio']),
  ] },
  { id: 'release', planId: 'demo-release', tasks: [
    step('demo-release-checklist', 'checklist', 'Completed', 'Les prérequis de publication sont réunis.', 'Version 1.8.0 : notes préparées, tests de démarrage réussis et signatures présentes.'),
    step('demo-release-review', 'review', 'Completed', 'La revue des changements ne laisse aucun point bloquant.', 'Les changements audio et accessibilité sont couverts. Deux remarques mineures ont été corrigées.', ['demo-release-checklist']),
    step('demo-installers', 'installers', 'InReview', 'Relire le bilan des paquets iOS et Android.', 'Les deux paquets démarrent. Le bilan de vérification attend votre relecture avant la publication.', ['demo-release-review'], { reviewAfter: true }),
  ] },
  { id: 'client', planId: 'demo-assistant', tasks: [
    step('demo-client-brief', 'specify', 'AwaitingResponse', 'Préciser le délai et le public de la réponse.', 'La demande concerne-t-elle un client existant ou une première prise de contact ? Quel délai pouvons-nous annoncer ?', [], { interaction: 'question' }),
    step('demo-client-answer', 'implement', 'Blocked', 'Rédiger une réponse adaptée à la demande.', 'La rédaction attend les précisions sur le client.', ['demo-client-brief']),
    step('demo-client-check', 'verify', 'Blocked', 'Vérifier le ton et les engagements annoncés.', 'La vérification commencera après la rédaction.', ['demo-client-answer']),
  ] },
  { id: 'voice', planId: 'demo-voice', tasks: [
    step('demo-voice-transcribe', 'transcribe', 'Completed', 'La transcription contient deux noms incertains.', 'La réunion mentionne « Ana » à 04:12 et « Maël » à 11:38. Les passages concernés sont conservés dans la transcription.'),
    step('demo-transcript', 'clarify', 'AwaitingResponse', 'Confirmer l’orthographe de deux participants.', 'Pouvez-vous confirmer les noms entendus à 04:12 et 11:38 ? Le résumé attend votre réponse.', ['demo-voice-transcribe'], { interaction: 'question' }),
    step('demo-summary', 'summarize', 'Blocked', 'Rédiger les décisions et les prochaines étapes.', 'Le résumé attend la clarification des passages ambigus.', ['demo-transcript']),
    step('demo-voice-review', 'review', 'Blocked', 'Comparer le résumé à la transcription.', 'La vérification de fidélité attend le résumé.', ['demo-summary']),
  ], completedSteps: ['confidence'] },
  { id: 'quality', planId: 'demo-quality', tasks: [
    step('demo-quality-scope', 'scope', 'Completed', 'Contrôler le formulaire et les routes privées.', 'Le périmètre comprend la connexion, le formulaire client et les messages d’erreur.'),
    step('demo-security', 'security', 'Completed', 'Les routes privées refusent les sessions expirées.', 'Les contrôles d’accès sont terminés. Aucune exposition de données n’a été relevée.', ['demo-quality-scope']),
    step('demo-keyboard', 'accessibility', 'InProgress', 'Contrôler le focus et la navigation clavier.', 'Le contrôle reproduit le retour du focus après une erreur de formulaire.', ['demo-quality-scope']),
    step('demo-quality-content', 'content', 'Completed', 'Les libellés et les liens sont cohérents.', 'Les textes du portail et les liens d’aide ont été relus.', ['demo-quality-scope']),
    step('demo-quality-summary', 'synthesize', 'Blocked', 'Rassembler les trois rapports indépendants.', 'La synthèse attend la fin du contrôle d’accessibilité.', ['demo-security', 'demo-keyboard', 'demo-quality-content']),
    step('demo-quality-approval', 'approval', 'Blocked', 'Autoriser la livraison après la synthèse.', 'L’accord de livraison sera demandé lorsque les trois contrôles seront réunis.', ['demo-quality-summary'], { interaction: 'approval' }),
  ], completedSteps: ['fork'] },
  { id: 'ingestion', planId: 'demo-ingestion', tasks: [
    step('demo-catalog-inspect', 'inspect', 'Completed', 'Le fichier contient 240 références fournisseur.', 'Les colonnes et l’encodage sont reconnus. Douze lignes demandent une correction.'),
    step('demo-catalog-normalize', 'normalize', 'Completed', 'Les montants et les unités sont normalisés.', 'Les valeurs d’origine sont conservées dans le rapport de contrôle.', ['demo-catalog-inspect']),
    step('demo-catalog', 'repair', 'Failed', 'Fournir les références SKU manquantes.', 'La correction ne peut pas inventer les SKU de douze lignes. Joignez un fichier corrigé pour reprendre ; rien n’a été enregistré dans le catalogue.', ['demo-catalog-normalize']),
    step('demo-catalog-report', 'report', 'Blocked', 'Présenter le bilan après la correction.', 'Le bilan attend la résolution des lignes invalides.', ['demo-catalog']),
  ], completedSteps: ['prepare', 'validate', 'valid'] },
  { id: 'incident', planId: 'demo-incident', tasks: [
    step('demo-incident-triage', 'triage', 'Completed', 'La latence concerne l’import du catalogue.', 'La période 10:00–10:15 est retenue. Le p95 est passé de 220 à 840 ms.'),
    step('demo-latency', 'investigate', 'InProgress', 'Comparer le cache aux accès base de données.', 'Les traces sont examinées. L’expiration simultanée du cache reste une hypothèse à vérifier.', ['demo-incident-triage']),
    step('demo-incident-verify', 'verify', 'Blocked', 'Vérifier l’hypothèse contre les traces.', 'Aucune cause n’est considérée comme confirmée avant ce contrôle.', ['demo-latency']),
    step('demo-postmortem', 'conclude', 'Blocked', 'Documenter la cause et les mesures préventives.', 'Le compte rendu attend la confirmation de l’hypothèse.', ['demo-incident-verify']),
  ], completedSteps: ['collect'] },
  { id: 'refund', planId: 'demo-refund', tasks: [
    step('demo-refund-understand', 'understand', 'Completed', 'La demande porte sur la commande 1042.', 'Le client demande le remboursement d’un article livré, pour un montant de 89 €.'),
    step('demo-refund-eligibility', 'eligibility', 'Completed', 'La commande respecte les critères de remboursement.', 'Le délai est respecté et le motif correspond à la politique commerciale.', ['demo-refund-understand']),
    step('demo-refund-review', 'approval', 'AwaitingResponse', 'Autoriser le remboursement de 89 €.', 'La commande est éligible. L’accord du responsable est requis avant tout remboursement ; aucune action n’a encore été effectuée.', ['demo-refund-eligibility'], { interaction: 'approval' }),
    step('demo-order-mail', 'notify', 'Blocked', 'Préparer la réponse après la décision.', 'La réponse finale attend la décision et le résultat de l’action autorisée.', ['demo-refund-review']),
  ], completedSteps: ['lookup', 'eligible'] },
  { id: 'editorial', planId: 'demo-editorial', tasks: [
    step('demo-editorial-research', 'research', 'Completed', 'Les sources du dossier sont réunies.', 'Quatre sources vérifiables couvrent le sujet et ses limites.'),
    step('demo-editorial-technical', 'technical', 'Completed', 'L’angle technique est rédigé.', 'Le texte explique les choix techniques et leurs limites.', ['demo-editorial-research']),
    step('demo-editorial-practical', 'practical', 'Completed', 'Le guide pratique est rédigé.', 'Le guide décrit les étapes et les questions courantes.', ['demo-editorial-research']),
    step('demo-copy', 'edit', 'Pending', 'Harmoniser les deux contributions.', 'Les deux textes sont disponibles. Vous pouvez lancer la relecture finale.', ['demo-editorial-technical', 'demo-editorial-practical']),
  ], completedSteps: ['fork', 'join'] },
  { id: 'delivery', planId: 'demo-delivery', tasks: [
    step('demo-delivery-scope', 'coordinator', 'Completed', 'Vérifier la même version sur deux plateformes.', 'Les paquets web et mobile sont associés à la version 1.8.0.'),
    step('demo-delivery-web', 'web', 'Completed', 'Les preuves de la version web sont réunies.', 'Le spécialiste web a contrôlé le paquet et transmis ses preuves.', ['demo-delivery-scope']),
    step('demo-delivery-mobile', 'mobile', 'InProgress', 'Contrôler les paquets mobiles.', 'Le spécialiste mobile vérifie les signatures et le démarrage des paquets.', ['demo-delivery-web']),
    step('demo-delivery-evidence', 'coordinatorReview', 'Blocked', 'Consolider les preuves des deux plateformes.', 'L’expertise partagée attend le contrôle mobile.', ['demo-delivery-mobile']),
    step('demo-delivery-approval', 'approval', 'Blocked', 'Autoriser la publication de la version contrôlée.', 'La demande d’accord attend la consolidation des preuves.', ['demo-delivery-evidence'], { interaction: 'approval' }),
  ] },
  { id: 'persistent', planId: 'demo-persistent', tasks: [
    step('demo-writer', 'write', 'InProgress', 'Rédiger le dossier avec le même contexte.', 'Le rédacteur conserve les décisions prises au fil des échanges.', [], { finishAfter: ['demo-writer-steering'] }),
    step('demo-writer-direction', 'observe', 'AwaitingResponse', 'Confirmer l’angle du dossier.', 'Le dossier doit-il privilégier les exemples techniques ou les usages métier ? Votre réponse sera transmise au rédacteur.', [], { interaction: 'question' }),
    step('demo-writer-steering', 'steer', 'Blocked', 'Transmettre la consigne au rédacteur actif.', 'La consigne attend la confirmation de l’angle.', ['demo-writer-direction']),
    step('demo-writer-review', 'review', 'Blocked', 'Relire le dossier et demander une nouvelle passe si nécessaire.', 'La revue attend le dossier et la consigne de l’observateur.', ['demo-writer', 'demo-writer-steering']),
  ], completedSteps: ['start'] },
  { id: 'resident', planId: 'demo-resident', tasks: [
    step('demo-support-concierge', '/agents/concierge', 'AwaitingResponse', 'Donner la référence de commande du client.', 'Quel est le numéro de commande ? Chaque spécialiste reste disponible indépendamment des autres.', [], { interaction: 'question' }),
    step('demo-support-orders', '/agents/orders', 'Completed', 'Le suivi de la commande 1038 est disponible.', 'La commande 1038 a été expédiée. Aucun remboursement n’a été déclenché.'),
    step('demo-support-policy', '/agents/policy', 'Pending', 'Poser une question sur la politique commerciale.', 'Le référent peut expliquer une règle sans démarrer les autres agents.', [], { interaction: 'question' }),
  ] },
  { id: 'competition', planId: 'demo-competition', tasks: [
    step('demo-race-metrics', 'metrics', 'Completed', 'La piste des métriques manque de preuves.', 'Le rapport indique approved: false. Cette piste n’a pas été retenue.'),
    step('demo-race-traces', 'traces', 'Completed', 'Les traces étayent une première hypothèse.', 'Le rapport indique approved: true. La piste du cache est retenue après la fin des recherches concurrentes.'),
    step('demo-race-result', 'summarize', 'InReview', 'Relire la piste retenue et ses preuves.', 'La synthèse distingue l’hypothèse étayée d’une cause définitivement confirmée.', ['demo-race-metrics', 'demo-race-traces'], { reviewAfter: true }),
  ], completedSteps: ['fork', 'winner'] },
  { id: 'structured', planId: 'demo-structured', tasks: [
    step('demo-product-extract', 'extract', 'InProgress', 'Corriger le type du prix dans le résultat JSON.', 'Première sortie rejetée : price était une chaîne. Les erreurs ont été renvoyées au même agent ; la seconde tentative est en cours.'),
    step('demo-product-result', 'publish', 'Blocked', 'Présenter uniquement la fiche au format validé.', 'La fiche ne sera présentée qu’après validation du schéma.', ['demo-product-extract']),
  ], completedSteps: ['correctable', 'feedback'] },
  { id: 'approvals', planId: 'demo-approvals', tasks: [
    step('demo-publication-prepare', 'prepare', 'Completed', 'Le dossier et sa version sont prêts.', 'Les deux accords porteront sur le même dossier, sans changement de version entre les validations.'),
    step('demo-publication-editorial', 'editorial', 'Completed', 'L’accord éditorial est obtenu.', 'L’équipe éditoriale a validé cette version du dossier.', ['demo-publication-prepare'], { interaction: 'approval' }),
    step('demo-publication-legal', 'legal', 'AwaitingResponse', 'Donner le second accord avant la publication.', 'L’accord éditorial est acquis. L’accord juridique est encore attendu ; le dossier n’a pas été publié.', ['demo-publication-editorial'], { interaction: 'approval' }),
    step('demo-publication-result', 'confirm', 'Blocked', 'Présenter le résultat de publication.', 'La confirmation attend les deux accords puis le résultat de publication.', ['demo-publication-legal']),
  ] },
  { id: 'crisis', planId: 'demo-crisis', tasks: [
    step('demo-crisis-metrics', 'metrics', 'Completed', 'Les métriques identifient le pic de latence.', 'Le p95 à 840 ms est confirmé sur le service catalogue.'),
    step('demo-crisis-traces', 'traces', 'Completed', 'Les traces étayent la piste du cache.', 'Cette piste a été retenue ; les autres recherches sont terminées.'),
    step('demo-crisis-customer', 'customer', 'Completed', 'L’impact métier est documenté.', 'Dix-sept commandes ont rencontré un échec pendant la période observée.'),
    step('demo-crisis-decision', 'decide', 'Completed', 'Une intervention ciblée est retenue.', 'Le responsable choisit de préparer une intervention plutôt que de poursuivre la surveillance.', ['demo-crisis-metrics', 'demo-crisis-traces', 'demo-crisis-customer']),
    step('demo-crisis-plan', 'intervention', 'Completed', 'Le spécialiste a évalué l’intervention.', 'Le plan d’intervention et les critères de retour arrière sont prêts.', ['demo-crisis-decision']),
    step('demo-crisis-operations', 'operationsApproval', 'Completed', 'L’équipe opérations a donné son accord.', 'L’accord couvre cette intervention précise sur le service catalogue.', ['demo-crisis-plan'], { interaction: 'approval' }),
    step('demo-crisis-security', 'securityApproval', 'AwaitingResponse', 'Donner l’accord sécurité avant l’intervention.', 'L’accord opérations est acquis. Le déploiement reste interdit tant que l’accord sécurité manque.', ['demo-crisis-operations'], { interaction: 'approval' }),
    step('demo-crisis-technical', 'technical', 'Blocked', 'Contrôler les indicateurs après l’intervention.', 'Le contrôle attend l’intervention autorisée.', ['demo-crisis-security']),
    step('demo-crisis-business', 'business', 'Blocked', 'Contrôler les commandes après l’intervention.', 'Le contrôle métier démarrera en parallèle du contrôle technique.', ['demo-crisis-security']),
    step('demo-crisis-closure', 'closure', 'Blocked', 'Faire auditer les deux preuves de rétablissement.', 'L’audit attend les deux contrôles indépendants.', ['demo-crisis-technical', 'demo-crisis-business']),
    step('demo-crisis-report', 'report', 'Blocked', 'Présenter la clôture de l’incident.', 'Le rapport attend l’audit des preuves.', ['demo-crisis-closure']),
  ], completedSteps: ['launch', 'first'] },
  { id: 'fix', planId: 'demo-fix', tasks: [
    step('demo-fix-triage', 'triage', 'Completed', 'Le ticket est un correctif.', 'Le formulaire de contact perd la pièce jointe après une erreur de validation. Le ticket est qualifié comme correctif.'),
    step('demo-fix-develop', 'develop', 'Completed', 'Les tests du formulaire passent à la deuxième tentative.', 'Première exécution : deux tests en échec sur la conservation du fichier. Le développeur a repris le correctif avec ces échecs ; la suite du portail passe désormais.', ['demo-fix-triage']),
    step('demo-fix-review', 'review', 'InReview', 'Relire le correctif et ses tests.', 'Le changement conserve la pièce jointe dans l’état du formulaire. Choisissez accepter ou reprendre ; une reprise renverra vos remarques au même développeur.', ['demo-fix-develop'], { reviewAfter: true }),
    step('demo-fix-approval', 'releaseApproval', 'Blocked', 'Autoriser la publication du correctif.', 'L’accord sera demandé après une relecture acceptée. Rien n’a été publié.', ['demo-fix-review'], { interaction: 'approval' }),
    step('demo-fix-release', 'release', 'Blocked', 'Publier le correctif autorisé.', 'La publication attend l’accord du responsable.', ['demo-fix-approval']),
  ], completedSteps: ['tests', 'passed', 'failures'] },
  { id: 'shared-assistant', planId: 'macro-assistant', projectId: 'demo-meridian', tasks: [
    step('demo-shared-assistant', 'agent1', 'AwaitingResponse', 'Donner une consigne à l’assistant.', 'Que souhaitez-vous réaliser ? Vous pouvez joindre vos documents dans cette tâche.', [], { interaction: 'question' }),
  ] },
  { id: 'shared-chantier', planId: 'macro-chantier', projectId: 'demo-luma', tasks: [
    step('demo-chantier-plan', 'agent1', 'Completed', 'Le chantier est réparti en trois étapes.', 'Le périmètre et les critères de vérification sont définis.'),
    step('demo-chantier-build', 'agent2', 'InProgress', 'Réaliser les changements du chantier.', 'Les modifications suivent le périmètre préparé par le premier agent.', ['demo-chantier-plan']),
    step('demo-chantier-check', 'agent3', 'Blocked', 'Vérifier le résultat du chantier.', 'La vérification attend la réalisation.', ['demo-chantier-build']),
  ] },
];

demoExecutionScenes.push(
  { id: 'refund-denied', label: 'Remboursement accompagné · Commande 1049', planId: 'demo-refund', tasks: [
    step('demo-refund-denied-brief', 'understand', 'Completed', 'La commande 1049 concerne un article ouvert.', 'Le client demande un remboursement de 129 € pour un article déjà utilisé.'),
    step('demo-refund-denied-eligibility', 'eligibility', 'Completed', 'Le dossier nécessite une décision commerciale.', 'Le délai est respecté, mais l’état de l’article exige une décision du responsable.', ['demo-refund-denied-brief']),
    step('demo-refund-denied-decision', 'approval', 'Completed', 'Le remboursement a été refusé.', 'Le responsable refuse le remboursement et propose un échange. Aucun remboursement n’a été effectué.', ['demo-refund-denied-eligibility'], { interaction: 'approval' }),
    step('demo-refund-alternative', 'alternative', 'InReview', 'Relire la proposition d’échange avant de répondre.', 'Un échange sans frais est proposé. Vérifiez le délai et les conditions avant l’envoi au client.', ['demo-refund-denied-decision'], { reviewAfter: true }),
    step('demo-refund-denied-notify', 'notify', 'Blocked', 'Informer le client après relecture de l’alternative.', 'La réponse attend votre relecture de la proposition d’échange.', ['demo-refund-alternative']),
  ], completedSteps: ['lookup', 'eligible'] },
  { id: 'publication-failed', label: 'Publication à double accord · Service indisponible', planId: 'demo-approvals', tasks: [
    step('demo-publication-failed-prepare', 'prepare', 'Completed', 'Le dossier de février est prêt.', 'Les deux équipes examinent la même version du dossier de février.'),
    step('demo-publication-failed-editorial', 'editorial', 'Completed', 'L’équipe éditoriale a donné son accord.', 'L’accord porte sur le dossier de février.', ['demo-publication-failed-prepare'], { interaction: 'approval' }),
    step('demo-publication-failed-legal', 'legal', 'Completed', 'L’équipe juridique a donné son accord.', 'Le second accord est obtenu pour la même publication.', ['demo-publication-failed-editorial'], { interaction: 'approval' }),
    step('demo-publication-recovery', 'recover', 'AwaitingResponse', 'Choisir la suite après le refus du service de publication.', 'Le service a refusé la requête avant publication. Le dossier n’est pas publié. Souhaitez-vous différer la livraison ou préparer une nouvelle tentative ?', ['demo-publication-failed-legal'], { interaction: 'question' }),
  ], failedSteps: ['publish'] },
);

export const demoDesignNotes: Record<string, string> = {
  'demo-voice': 'Le contrôle de confiance dirige les passages incertains vers une clarification humaine. Le compte rendu et sa vérification attendent cette réponse.',
  'demo-quality': 'Trois spécialistes contrôlent le même périmètre en parallèle. Leurs rapports sont réunis avant la synthèse et l’accord de livraison.',
  'demo-ingestion': 'Le contrôle du schéma sépare le catalogue conforme des lignes à corriger. L’enregistrement intervient seulement après un résultat valide ; les erreurs ont leur propre parcours.',
  'demo-incident': 'Le triage choisit entre investigation et escalade. Une hypothèse non confirmée repart en diagnostic, avec une limite de trois passages.',
  'demo-refund': 'Le système vérifie la commande et son éligibilité. Le remboursement nécessite l’accord du responsable ; la réponse au client vient après la décision.',
  'demo-editorial': 'La recherche alimente deux rédacteurs indépendants. La relecture finale attend les deux contributions, sans imposer leur ordre de réalisation.',
  'demo-delivery': 'Le même modèle de contrôle est utilisé pour le web et le mobile, avec des spécialistes et des paramètres différents. Les graphes de détail montrent ce qui est réutilisé.',
  'demo-persistent': 'Le rédacteur garde son contexte pendant que l’observateur vous interroge. La consigne lui est transmise en cours de rédaction, puis la revue peut demander une nouvelle passe au même agent.',
  'demo-resident': 'Cette équipe n’impose aucun ordre d’exécution. L’accueil, le suivi des commandes et le référent commercial restent disponibles séparément.',
  'demo-competition': 'Deux chercheurs proposent des pistes concurrentes. Le premier résultat acceptable est retenu après confirmation de l’arrêt des autres travaux ; la synthèse conserve ses preuves.',
  'demo-structured': 'Le résultat doit respecter un schéma JSON. Une erreur de format retourne au même agent pour correction ; une erreur technique suit un autre chemin.',
  'demo-approvals': 'Les accords éditorial et juridique portent sur la même publication. Ils se succèdent avant l’action externe, et un refus empêche la publication.',
  'demo-crisis': 'Trois investigations alimentent une décision entre intervention, surveillance et escalade. L’intervention exige deux accords ; sa clôture attend ensuite les preuves techniques et métier.',
  'demo-fix': 'Le ticket est qualifié parmi quatre issues. Un échec de tests repart chez le développeur avec les erreurs, tout comme une relecture à reprendre ; la publication attend un accord explicite.',
  'demo-audio-feature': 'Le besoin précède la modification du lecteur, puis les tests vérifient les cas de pause et de chargement. Le résultat de chaque agent est transmis au suivant.',
  'macro-assistant': 'L’assistant commun attend la consigne dans sa tâche. Le même blueprint peut être lancé dans chacun des projets.',
  'macro-chantier': 'Le chantier passe du cadrage à la réalisation puis à la vérification. Chaque étape possède sa propre tâche dans le projet choisi.',
};

const archivedEditorial = demoExecutionScenes.find(scene => scene.id === 'editorial')!;
const archiveIds = new Map(archivedEditorial.tasks.map(task => [task.id, task.path.endsWith('/practical') ? 'demo-archived-guide' : `${task.id}-archive`]));
demoExecutionScenes.push({ ...archivedEditorial, id: 'editorial-archive', archived: true,
  tasks: archivedEditorial.tasks.map(task => ({ ...task, id: archiveIds.get(task.id)!, status: 'Completed', after: task.after.map(id => archiveIds.get(id)!), description: 'Édition précédente du dossier, conservée dans les archives.', reply: 'Cette contribution appartient à la précédente édition terminée du dossier.' })),
});

function sceneCard(plan: Plan, path: string) {
  const viewer = projectViewer(plan.agsdl.source, plan.agsdl);
  return [...viewer.graphs.flatMap(graph => graph.cards), ...viewer.declarations].find(card => card.path === path);
}

export function demoBlueprintSteps(plan: Plan): DemoWorkflowStep[] | undefined {
  const scene = demoExecutionScenes.find(scene => scene.planId === plan.id && !scene.archived);
  if (!scene) return;
  const source = JSON.parse(plan.agsdl.source);
  return scene.tasks.map(task => {
    const card = sceneCard(plan, task.path);
    if (!card) throw new Error(`Missing demo component: ${plan.id}${task.path}`);
    const declaration = task.path.startsWith('/agents/') ? object(source.agents)[task.path.slice('/agents/'.length)] : object(source.agents)[text(object(card.details).agent)];
    const prompt = Array.isArray(object(declaration).prompt) ? (object(declaration).prompt as Array<{ value?: string }>).map(part => part.value ?? '').join('\n') : task.description;
    return { key: task.id, path: task.path, title: card.title, prompt, after: task.after, interaction: task.interaction, reviewAfter: task.reviewAfter, finishAfter: task.finishAfter };
  });
}

export function buildDemoExecutions(plans: Plan[], date: string) {
  const tasks: Task[] = [];
  const executions: TaskExecutionGraph[] = [];
  const replies = new Map<string, string>();
  for (const scene of demoExecutionScenes) {
    const plan = plans.find(plan => plan.id === scene.planId);
    if (!plan) throw new Error(`Missing demo blueprint: ${scene.planId}`);
    const taskPaths: Record<string, string> = {};
    for (const [index, entry] of scene.tasks.entries()) {
      const card = sceneCard(plan, entry.path);
      if (!card) throw new Error(`Missing demo component: ${scene.planId}${entry.path}`);
      taskPaths[entry.path] = entry.id;
      tasks.push({ id: entry.id, plan_id: plan.id, project_id: scene.projectId ?? plan.projectId, title: card.title, description: entry.description,
        status: entry.status, dependencies: entry.after, blocked_by_task_ids: entry.status === 'Blocked' ? entry.after.filter(id => scene.tasks.find(task => task.id === id)?.status !== 'Completed') : [],
        is_blocked: entry.status === 'Blocked', is_ready: entry.status === 'Pending', estimated_changes: [], task_source: 'standalone',
        execution_targets: [{ projectId: scene.projectId ?? plan.projectId, branchName: '', executionMode: 'direct', executionKind: 'repository_root', worktreeKey: `${scene.projectId ?? plan.projectId}:${scene.id}` }],
        ...(entry.id === 'demo-audio' ? { branch_name: 'feature/audio-playback', assigned_branch: 'feature/audio-playback', execution_targets: [{ projectId: scene.projectId ?? plan.projectId, branchName: 'feature/audio-playback', executionMode: 'git' as const, executionKind: 'worktree' as const, worktreeKey: `${scene.projectId ?? plan.projectId}:feature/audio-playback` }] } : {}),
        conversation_id: entry.id === 'demo-audio' ? 'demo-task-chat' : `${entry.id}-chat`, sequence_index: index, archived_at: scene.archived ? date : null,
      });
      replies.set(entry.id, entry.reply);
    }
    executions.push({ title: scene.label ?? (scene.archived ? `${plan.title} · Édition précédente` : plan.title), source: plan.agsdl.source, display: structuredClone(plan.agsdl.display), migration: structuredClone(plan.agsdl.migration), taskPaths, selectedPath: '', simulated: true,
      activity: Object.fromEntries([...(scene.completedSteps ?? []).map(name => [`/flow/steps/${name}`, { state: 'completed' as const, activations: [] }]), ...(scene.failedSteps ?? []).map(name => [`/flow/steps/${name}`, { state: 'failed' as const, activations: [] }])]) });
  }
  return { tasks, executions, replies };
}
