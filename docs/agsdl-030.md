# Concevoir un système AgSDL 0.3 dans Macro

Les nouveaux brouillons et les quatre blueprints inclus utilisent
`agsdl-0.3.0`. Les sources existantes 0.1 et 0.2 gardent leur édition, leurs
annexes et leur provenance. Copier un blueprint ne le migre pas.
La référence normative est le [tag AgSDL v0.3.0](https://github.com/Andrologic/AgSDL/tree/v0.3.0).

## Créer et adapter

Le document minimal ne suppose ni graphe, ni installation de moteur :

```json
{
  "contract": "agsdl-0.3.0",
  "id": "project-assistant",
  "agents": {}
}
```

`title` et `description` sont facultatifs. Les noms ont au plus 64 caractères.
Un agent déclare directement son `harness` et ses `permissions`. Ses instructions
permanentes restent distinctes du `prompt` de mission et des ressources reçues
comme information. Comprendre, planifier, réaliser et vérifier une mission se
font dans la même conversation. Les blueprints produit confient une mission
complète à un agent, puis une revue indépendante à une nouvelle instance. Ils
transmettent les rapports explicitement et bornent les retours en correction.
Le modèle est omis pour laisser le défaut du harness ; aucun nom fictif ni
commande de vérification arbitraire n’est présenté comme déjà configuré.

Les informations de conception et les titres d’affichage Macro restent dans
l’enveloppe du plan pour 0.2 et 0.3. Un changement de métadonnées seul conserve
les octets de la source. Une adaptation applique une valeur uniquement à une
chaîne existante désignée par son `targetPath`. Les métadonnées inconnues, les
annexes, l’historique et la provenance du blueprint restent préservés.

## Rédiger par le chat

Lire `agsdl_get` avec le plan et la branche de stockage de la conversation,
puis `section: "guide"`. Le guide dépend de l’édition de la source ; une source
vide sélectionne 0.3. La référence chargée à la demande est
[`guide030.ts`](../src/services/agsdl/guide030.ts). Elle détaille les agents,
les résultats et soumissions, les permissions, les skills et MCP, les messages,
les instances et le steering, les appels, les approvals, les fan-outs, les joins,
les compositions imbriquées, les limites, les diagnostics et la conservation.
Elle inclut six exemples complets supplémentaires, consultables dans le guide.
Les quatre identifiants sélectionnables par `agsdl_update example` restent
`release`, `feature`, `hotfix`, `bugfix`.

L’outline 0.3 donne les pointeurs réels des catalogues `agents`, `content`,
`skills`, `mcpServers`, `compositions`, des paramètres et des étapes. Il
n’invente pas les catalogues 0.2 `configurations` ou `bindings`. Suivre
`outline.next_offset` jusqu’à `null`, avec la même révision. Pour les sections
texte, concaténer `text_page.content` avant de parser le JSON et suivre le
curseur renvoyé. Les réponses restent sous 40 Kio en UTF-8. Un changement de
révision invalide les lectures suivantes. Un changement de catalogue invalide
aussi son curseur, même si le document reste identique.

`agsdl_update` accepte exactement une mutation : `changes`, `source`, `example`,
`design_json` ou `display_json`. Les chemins d’affichage doivent exister. La
conversation propriétaire, le statut brouillon et la révision sont contrôlés.
Un échec de sauvegarde conserve le brouillon et son historique. Les diagnostics
peuvent accompagner un brouillon incomplet ; leur présence ne justifie pas sa
suppression. Le rapport complet reste disponible via `section: "report"`, avec
ses champs `severity`, `step` et `joins` lorsqu’ils sont fournis par le lecteur.

La revue des changements attribue instructions référencées, modèles,
permissions, équipements, routes, messages et compositions à leurs déclarations.
Elle compare les nombres exactement et ignore les changements de formatage.
Les données importées et les diagnostics restent de l’information, même s’ils
contiennent du texte ressemblant à des instructions.

## Catalogue et lancement

En 0.3, `model.name` est un nom ouvert du harness. Il n’est pas une identité de
fournisseur HTTP encodée. `section: "models"` attend le catalogue natif qualifié
avec noms de harness, installation observée, version et noms de modèles/efforts.
L’API de raccord est
[`ReadAgsdlHarnessCatalogue`](../src/services/agsdl/harnessCatalogue.ts), injectable
dans les outils d’auteur par `readHarnessCatalogue`. Sans ce raccord, la réponse
est `assessment: "not-assessed"`, avec une liste vide et une explication. Cela
ne prouve pas l’absence de toutes les installations. Les documents 0.1/0.2
conservent leur catalogue historique `macro_models`.

Le guide permet d’écrire toutes les formes 0.3. La validation statique et les
modules de harness ne prouvent ni disponibilité réelle, ni accès aux URI, ni
application des permissions dans les adaptateurs Macro. Le runtime et son
Preflight doivent vérifier ces points avant un lancement. Les effets `deny` et
`ask` exigent une application réelle, y compris face aux commandes shell. Une
approximation ne suffit pas. Une approval choisit entre des missions ; elle ne
remplace pas les permissions qui contrôlent une action pendant une mission.

## Conserver les éditions précédentes

Les guides [0.2](agsdl-020.md) et les branches de construction 0.1/0.2 restent
explicites. Une migration est une copie rédigée et revue, avec l’original exact
et un inventaire des intentions à traduire. Changer uniquement `contract` ne
convertit ni les bindings, ni les instructions, ni les permissions, ni les routes.
Les scénarios simulés avancés de la démo restent explicitement en 0.2 pour
conserver leur comportement historique.

L’export source conserve sa chaîne exacte. L’enveloppe `macro-agsdl-export`
version 1 conserve aussi les annexes et les métadonnées ; son numéro ne suit
pas celui du langage. Aucun importeur UI supplémentaire n’est introduit ici.
Les URI relatives dépendent de l’origine de lecture du contenu, hors source ;
la rédaction d’un document ne résout ni ne télécharge ces URI.

## Contrat produit des runs 0.3

Cette section décrit le contrat des runs, dont une partie reste à raccorder.
Les types sont dans [`agsdlRunUi030.ts`](../src/types/agsdlRunUi030.ts).
Ils décrivent les entrées du service UI et ses vues publiques. Ce ne sont ni des
DTO IPC générés ni des capacités natives. Les commandes existantes restent
soumises à leurs validations Rust ; les extensions ci-dessous restent fermées
jusqu'à leur intégration et leur qualification. Start et Stop sont raccordés
pour la tranche Codex 0.167.x qualifiée sur macOS ARM64 et Linux ARM64 :
agents, ressources inline, résultats et corrections, choix et limites de visites.
Les étapes `call` sont aussi raccordées sur macOS ARM64 avec le confinement
natif. Les commandes et serveurs MCP locaux sur stdio tournent dans le dossier
du projet, sans réseau ni environnement hérité, sous le plafond `workspace`
approuvé de l'hôte et du projet. Aucun dépôt Git n'est nécessaire. `parse`
accepte `json` et `lines`. Un code de sortie non nul, ou `isError` pour MCP,
produit l'issue normale `failed` ; un JSON invalide produit `OUTPUT_INVALID`.
Le moniteur affiche le code de sortie et le texte de la commande. Stop attend
l'arrêt du processus et de ses descendants avant de terminer le run.

Les serveurs MCP HTTP restent refusés, car l'arrêt distant ne peut pas être
confirmé. Les étapes `approval` proposent les choix déclarés et conservent le
commentaire exact. Le panneau « Demandes pour vous » permet de répondre et
signale leur expiration. Les questions de formulaire des appels MCP stdio
utilisent le même suivi humain. `answerTimeoutMs` décline une question restée
sans réponse, puis le serveur continue. `timeoutMs` borne le temps machine des
agents et des appels et reste suspendu pendant leurs demandes humaines.
Une approbation utilise son propre `timeoutMs` et échoue avec `APPROVAL_TIMEOUT`.
Les délais attendent l'arrêt du travail et de ses descendants avant de suivre
`onError`. Les réponses dépassant 65 536 octets JSON sont refusées avant
leur enregistrement.

Les messages `queue` et `steer` sont raccordés à Codex 0.167.x. Dans un document
sans flow, Start ouvre une exécution en attente ; le panneau Messages permet
d'envoyer une mission à son agent partagé. Une livraison en file démarre un
nouveau travail après le travail courant. Un steer rejoint le tour actif via
`turn/steer` et attend le `userMessage` corrélé de Codex avant la consommation.
Si le destinataire finit avant l'envoi, le message repart en file. Une
consommation incertaine n'est jamais rejouée. Le moniteur conserve les messages
envoyés, livrés, consommés et repliés, avec la réponse de l'agent.

Une définition conserve sa conversation partagée jusqu'à la fin du run. Une
instance nommée conserve sa propre conversation, distincte des autres noms et
des autres définitions. `instance: "new"` crée une conversation pour chaque
travail. Aucun fil n'est réutilisé entre deux runs. Les références en mémoire
appartiennent à l'exécuteur du run et sont libérées avec lui après la fin des
travaux, y compris après un arrêt ou un échec. Cela ne supprime pas l'historique
privé conservé par Codex et ne permet pas de reprendre un run après redémarrage.

Chaque reprise transmet les exigences de résultat du travail courant, avec
ses choix de route. Les instructions permanentes restent dans les instructions
développeur ; la mission est l'entrée du nouveau tour. Seul `instructs: true`
autorise un agent à fournir une mission au suivant. Un prompt explicite de route
est prioritaire sur cette mission, puis le prompt de l'étape sert de repli.
Les ressources restent des données séparées, marquées non fiables, même si elles
contiennent des instructions produites par un autre agent. Une mission ne change
ni les instructions permanentes, ni les permissions, ni la qualification du
harness. Les soumissions non autorisées sont refusées dans le travail courant.

L'accès MCP des agents, les permissions `ask`, `planFirst: ask`, fan-out,
les compositions et les autres capacités hors tranche restent refusés.
Les runs interrompus au redémarrage restent consultables et ne reprennent pas.

L'autorisation exige ensemble `staticValid`, `runtimeSupported`, une
qualification native correspondant à la source et au registre, aucune propriété
requise non évaluée, `incomplete: false` et `productRuntimeAvailable: true`.
Un profil qualifié peut encore rester fermé au produit. Une porte de
qualification fermée impose `productRuntimeAvailable: false` dans les types.

### Autorité, identités et navigation

Le natif conserve source capturée, admission, intentions, décisions, horloges,
travaux et preuves physiques. L'UI fournit une portée publique, des identifiants
publics, la révision attendue et le contenu de sa réponse. Une clé client de
Start, livraison ou Stop sert uniquement à dédupliquer. Elle n'atteste aucun
travail. Les entrées humaines restent exactement
`{scope, requestId, expectedRevision, answer}`, avec le `HumanScope030` existant.
Les identités de propriétaire d'exécution, epoch, génération, tentative
fournisseur, call interne,
Start effect, ticket, preuve physique et instant de décision sont allouées ou
retrouvées par le natif. Ses décodeurs refusent les champs supplémentaires.

`RunStartInput030` et `RunDeliveryInput030` sont des intentions produit à adapter
par le lot UI 6 au contrat natif qualifié. Elles ne doivent pas être passées
telles quelles à `invoke`. Le service fixe le profil 0.3 ; les associations et
identifiants de corrélation requis par les DTO actuels doivent être validés par
le natif. La sélection d'une cible reste une déclaration publique d'agent et
d'instance shared/named, jamais une tentative fournisseur. `new` n'est pas une
cible de livraison externe. Les livraisons sans flow sont le premier périmètre
normatif ; les routes internes au flow restent conduites par le natif.

L'édition est explicite avant de choisir lecteur et commandes. Les captures
0.2 portent `snapshot: "1"`, `contract: "agsdl-0.2.0"`, profil
`macro-serial-inline-v1` ; les captures 0.3 portent `snapshot: "2"`,
`contract: "agsdl-0.3.0"`, profil `macro-agsdl-030-v1`. Les admissions natives
`start` et `start030` restent distinctes. `deliver` est historique ;
`execution_deliver030` admet désormais les messages sans flow dans les tables
0.3, avec un identifiant dédupliqué et une capture conservée. Son reçu confirme
l’admission ; la projection confirme séparément la livraison et la consommation.

L'ouverture d'Exécutions lit l'historique et les intentions retenues du même
projet, plan, branche et conversation. Elle ne compile, ne préflight,
n'acquitte et ne soumet rien. La vue montre
« Document courant » et « Source capturée » séparément. Une édition du document
ne remplace jamais la capture d'un run.

La navigation détache l'observation, sans arrêter le résident. Un retour relit
la même clé d'intention, les reçus et la capture. Un rafraîchissement conserve
sélection et brouillons humains indexés par scope et demande. Ces brouillons
doivent aussi être restaurables après rechargement de la page par le lot UI 8.
Une perte du host est différente d'une navigation : ses anciennes continuations
sont révoquées et les IO ambiguës restent incertaines.

### Sélection initiale du run

Cette section est la règle normative de sélection. Sans sélection explicite
encore valide dans le scope, l'ouverture choisit dans cet ordre :

1. Un run qui attend une personne, avec une demande ouverte attestée.
2. Le run de l'admission retenue, si elle possède un reçu de run valide.
3. Le dernier run du scope.

S'il existe plusieurs runs en attente humaine, leur ordre dans l'historique
natif, du plus récent au plus ancien, les départage. La lecture doit qualifier
la présence d'attentes sur l'historique du scope avant d'appliquer un repli ;
une page partielle ou un DTO humain indisponible ne prouve pas leur absence.
Le rafraîchissement conserve une sélection explicite valide et ne détourne
pas l'utilisateur de l'occurrence consultée.

### Actions et commandes natives

Les noms marqués « à créer » sont des propositions de contrat. Le propriétaire
indiqué possède la sémantique native ; l'intégrateur runtime I/09 garde l'unique
raccord des fichiers partagés et du registre IPC. Le lot UI 6 consomme les
wrappers générés, sans modifier leurs fichiers à la main.

| Action | Commande Rust existante ou proposée | Propriétaire runtime | Reçu et trou à combler |
| --- | --- | --- | --- |
| Consulter un run et ses occurrences | `execution_list_runs030`, `execution_read_run_correlation030`, `execution_read_snapshot`, `execution_read_runtime_projection030`, `execution_read_humans030`, `execution_read_intents`, `execution_read_intent` | N-OBS / projection et découverte ; humain U pour sa projection ; I/09 pour le raccord | Capture, révision, pages complètes et intentions existantes ; G3, G7, G8, G9 restent partiels. |
| Préflight explicite | `execution_preflight` | Fournisseurs lot 2, capture/admission ; fournisseurs lot 7 pour l'exposition | Source, validité et couverture ; G1 manque pour une qualification fournisseur exploitable. |
| Lancer | `execution_stage_intent`, `execution_submit_intent`, `execution_read_intent`, `execution_close_intent` ; dispatch existant `execution_start` | Fournisseurs lot 1 pour la pompe ; lot 2 pour l'admission ; lot 7 et I/09 pour les commandes | Intention durable et admission `start030` existantes ; G1 et raccord de production requis. |
| Livrer en queue | `execution_deliver030`, panneau Messages | Production Codex 0.167.x | Capture conservée, admission FIFO, travail distinct ; aucun appel aux livraisons historiques. |
| Livrer en steer | `execution_deliver030` et routes du flow, superviseur natif | Production Codex 0.167.x | Destinataire exact, accusé de consommation, repli avant envoi, aucun rejeu incertain. Les fan-outs et joins restent refusés au lancement produit. |
| Choisir le flow, avec commentaire d'approval | `execution_submit_human030`, lecture `execution_read_humans030` | Humain U, N-HUMAN H/B ; I/09 | G3 à G5, reçu de soumission puis décision et consommation ; aucun envoi du message approuvé par l'UI. |
| Approuver ou refuser une action `ask`, avec commentaire | Même nouvelle commande humaine | Humain U, N-HUMAN H/B et fournisseur propriétaire de l'action ; I/09 | G4 distingue permission et choix de flow ; G5 corrèle la remise à l'exécuteur possédé. |
| Accepter ou refuser un plan | Même nouvelle commande humaine | Humain U, N-HUMAN H/B ; fournisseurs lot 5 pour le verrou ; I/09 | G3 et G5, plan courant et verrou natifs, jamais un plan-id fourni par l'UI. |
| Répondre à une question | Même nouvelle commande, seulement avec validateur attesté | Humain U / N-HUMAN ; N-CALLS pour l'identité MCP et son port ; I/09 | G3, G5, G6 ; `expectedResponse` seul ne qualifie pas la réponse. |
| Stop système | `execution_stop` initial ; `execution_ensure_stop` pour reprendre un Stop conservé | Fournisseurs lot 5 / `agsdl_host_stop030.rs` ; I/09 | Reçu `requested` existant ; G7 pour attente physique et confirmation attestée. |
| Inspecter une incertitude et ses diagnostics | Lectures d'intention/projection existantes ; `execution_read_diagnostic030` et `execution_read_uncertainty030` à créer | N-OBS pour les lectures ; fournisseurs lots 1/5 pour réconciliation native ; I/09 | G8 et G10, état et reçus relus, sans autorisation de rejouer. |

### Corrélation historique du run avec sa conversation

`execution_read_run_correlation030({ scope, systemStartId })` est une lecture
native sans admission, réconciliation ni modification d'intention. Son wrapper
`readExecutionRunCorrelation030(scope, systemStartId)` est exporté par
`src/services/tauriIpc.ts`. Les types proviennent du générateur IPC.

L'entrée `scope: ExecutionIntentScope` contient `owner`, avec `projectId`,
`planId` et `branch`, et `conversationId`. Le natif valide le scope canonique
dans les métadonnées et l'appartenance de la conversation au projet en base.
Il cherche l'attachement durable au run dans ce scope, sans filtrer les lignes
clôturées. Une intention doit être `admitted` ou `closed` avec disposition
`acknowledged`. La requête Start persistée doit être identique à celle de
l'intention. Le natif vérifie le propriétaire, la source, le profil 0.3, les
versions, l'identité capture/reçu et les identifiants stockés du Start.

Le succès renvoie `ExecutionRunCorrelation030` :

```ts
{
  key: ExecutionIntentKey; // { scope, intentId }
  receipt: {
    systemStartId: string;
    flowInvocationId: string;
    source: EngineSourceRevision;
    versions: EngineVersions;
    entryDeliveryId: string | null;
  };
}
```

Aucun epoch, capacité, contenu privé de capture ou état d'exécution courant
n'est exposé. La preuve reste lisible après acquittement, clôture et redémarrage.
Elle atteste le lancement retenu, sans autoriser un nouveau travail.

Les rejets suivent `ExecutionIntentError`, avec `currentIntentKey: null` :

| Code | Condition |
| --- | --- |
| `INVALID_REQUEST`, `INPUT_LIMIT` | Identifiant ou scope mal formé, ou limite dépassée. |
| `SCOPE_INVALID` | Scope canonique invalide, conversation d'un autre projet, ou run 0.3 existant sans intention attachée dans ce scope. Cela inclut une autre conversation, un autre propriétaire, plan ou branche, et un run lancé hors du protocole d'intention. |
| `NOT_FOUND` | Aucun Start 0.3 ne porte cet identifiant, dans un scope valide. |
| `STORAGE_UNCERTAIN` | Lecture SQL/JSON impossible ou contradiction entre intention, requête, capture et reçu. |
| `SCOPE_UNAVAILABLE`, `RUNTIME_UNAVAILABLE` | Métadonnées du scope ou service natif indisponibles. |

Pour le lot UI 6a, attester chaque run découvert avec cette commande, puis
comparer le reçu à son résumé et à sa capture avant de l'inclure dans
l'historique. Traiter les refus par leur code typé. `execution_read_intents`
reste réservé aux intentions ouvertes et ne suffit pas à attester l'historique.
La commande de corrélation ne remplace pas les lectures de projection ou
demandes humaines et ne garantit pas leur fraîcheur.

### Entrées, refus et états en cours

`RunActionInputs030`, `RunActionReceipts030`, `RunRefusal030` et
`RunActionProgress030` décrivent chaque famille. Les codes produit supplémentaires
sont des exigences de DTO, à mapper explicitement sur les codes natifs. Un
message d'erreur libre n'est jamais parsé pour décider d'un état.

| Action | Entrée publique | En cours, reçu ou refus | Après conflit, navigation ou perte d'acquittement |
| --- | --- | --- | --- |
| Consultation | Scope de capture et curseur natif lié à sa révision | Chargement, prêt ou données périmées ; `CORRELATION`, `CONFLICT`, `REVISION_CONFLICT`, `NOT_FOUND` | Conserver l'ancienne vue marquée périmée. Recharger toutes les pages de la série ; aucune fusion de révisions ni action implicite. |
| Préflight | Scope du plan et source attendue, ou `null` pour la première évaluation | Évaluation en cours, puis validité statique, prise en charge native et porte de lancement séparées ; `SOURCE_CHANGED`, `HARNESS_REFUSED`, `POLICY_UNAVAILABLE` | Invalider l'évaluation si source, registre ou profil change. Refaire seulement sur demande explicite ; aucune inférence, installation ou connexion de compte. |
| Start | Scope d'intention, id conservé, source attendue, message d'entrée exact ou absence | `prepared`, `submissionPending`, `admitted`, `refused`, `closed` natifs ; `SLOT_OCCUPIED`, `IDENTITY_CONFLICT`, `SOURCE_CHANGED`, `PROFILE_UNQUALIFIED` | Relire la même intention et son admission `start030`. Un conflit conserve la saisie et propose une nouvelle évaluation ; il ne crée pas de nouvelle clé. |
| Queue | Scope du run, id conservé, révision, cible shared/named et message exact | Soumission puis reçu queued/started/withdrawn ; `TARGET_INVALID`, `TARGET_CLOSED`, `REVISION_CONFLICT`, `INPUT_CONSTRAINT` | Relire la même livraison. L'ordre FIFO vient des admissions natives. L'attente ne consomme ni visite ni temps machine. |
| Steer | Même entrée que queue, action `steer` explicite | Steer en attente puis absorption prouvée ; `STEER_UNSUPPORTED` en plus des refus queue | Une instance idle démarre un travail ; un travail ne comptant plus impose queue. Après admission vers une tentative précise, une remise ambiguë reste incertaine et ne vise jamais la tentative suivante. |
| Choix du flow | Scope humain, demande, révision, `{kind:"approval",choice,comment}` | Soumis, résolu, consommé, expiré ou annulé ; `INPUT_CONSTRAINT`, `REQUEST_CLOSED`, `ANSWER_EXPIRED`, conflit | Garder le brouillon, relire la demande et son reçu. Tout choix déclaré est normal. Le commentaire vide reste `""` ; le message et sa propagation sont reconstruits nativement. |
| Action `ask` | Même enveloppe, `{kind:"decision",decision:"yes" ou "no",comment}` | Même cycle ; `HUMAN_PURPOSE_UNATTESTED` si la finalité n'est pas prouvée | Un refus laisse le même agent continuer. L'autorisation vise seulement l'action corrélée ; elle n'élargit pas ses permissions. |
| Plan | Même enveloppe de décision et commentaire | Même cycle, révision du plan courant contrôlée nativement | Refus commenté : révision du plan avec verrou fermé. Refus vide : `PLAN_REJECTED` après fin physique. Acceptation : levée du seul verrou de plan. |
| Question | Même enveloppe, `{kind:"question",answerJson}` exact | Même cycle ; `QUESTION_UNATTESTED` sans validateur et `INPUT_CONSTRAINT` si réponse invalide | Garder le brouillon exact. Pas de conversion yes/no ni d'auto-validation depuis une description. Le refus MCP est remis au serveur et ne termine pas à lui seul le call. |
| Stop | Scope du run et id public conservé ; aucun Stop partiel promis | Demande d'arrêt, attente de fin physique, arrêté ou incertain ; `PARTIAL_STOP_UNAVAILABLE` pour une tentative partielle | Disponible pendant attente humaine ou intention en cours. Le natif arbitre sur l'état courant, sans exiger la révision du design. Relire le Stop conservé avant toute réconciliation. |
| Incertitude | Scope de capture et id public du fait incertain | Lecture en cours puis unresolved/reconciled ; `DTO_UNAVAILABLE`, `CORRELATION`, `NOT_FOUND` | Afficher les derniers faits attestés. Une absence de reçu, EOF ou disparition de parent ne prouve ni rollback ni fin des descendants. Aucun bouton Reprendre ne renvoie un effet. |

Les refus de portée ou de corrélation bloquent l'action. Les erreurs
`STORAGE_UNCERTAIN`, `RUNTIME_UNAVAILABLE`, `UNCERTAIN` et `STOP_PENDING` après
une soumission peuvent signifier que l'action a eu lieu. Elles déclenchent une
relecture, jamais un nouvel envoi avec un autre id. Un doublon humain sur la
même demande/révision ne crée aucune seconde résolution ; il retrouve le reçu
identique ou reçoit un conflit avec relecture. Un contenu différent pour la
même clé est refusé. Une requête HTTP/IPC répétée n'est pas une nouvelle action
utilisateur. La désactivation du bouton seule ne prouve pas cette idempotence.

`execution_ensure_stop` 0.3 ne crée actuellement aucun Stop : sans ligne durable,
il retourne `UNCERTAIN`. Il ne remplace donc pas l'appel initial à
`execution_stop`. Le reçu `requested` de ce dernier ne confirme pas l'arrêt.
La réconciliation native peut poursuivre cancellation et joins ; l'inspection
UI reste une lecture. Un Stop confirmé ne promet ni annulation d'effets déjà
produits ni arrêt d'un travail distant non attesté.

### États publics et inspection

Le verdict natif est `null`, `succeeded`, `failed` ou `cancelled`. Il reste
indépendant du Stop demandé, de l'activité physique, de l'attente humaine et des
incertitudes. Une erreur traitée peut laisser réussir le run. `call.failed`,
`join.incomplete` et `quorum.missed` sont des issues normales. Les travaux tardifs
sous `remaining: finish` restent visibles avec leur appartenance au flow ;
leur erreur ne devient pas un faux verdict global.

Une étape sélectionnée donne ses occurrences, identifiées par activation native
et capture, avec adresse développée, instance, groupe, chemins et indice de
fan-out. Le pointeur source désigne le propriétaire éditable, pas la visite.
Les détails disponibles montrent mission réellement reçue, émetteur, sortie,
décision, cause, handler suivi et effets déjà produits. Pour steer, la destination
déclarée et le travail physiquement rejoint restent deux identités distinctes.
Un call n'invente aucune instance Agent. Un join n'invente aucun travail.

Les `workIds` d'une demande historique sont des UUID publics distincts des
`RunOccurrence030.activation.id` ; ils ne peuvent pas servir à les retrouver
directement. `RunHumanRequest030.occurrences` contient exactement une entrée
par `workId`. Sa propriété `activation` est soit `available`, avec scope de
capture et `activationId`, soit explicitement `unavailable`, avec le trou
`human-occurrence-mapping`. Seule une conversion native attestée peut publier
le lien disponible, en vérifiant le scope humain, la capture et l'activation
correspondante dans une lecture cohérente. N-HUMAN et I/09 doivent fournir ce
DTO, trou G12. En son absence, les lots UI 7 et 8 conservent le lien indisponible
et la demande lisible. Ils ne rapprochent les identités ni par égalité des UUID,
ni par nom d'étape, pointeur source ou ordre des tableaux.

Chaque série paginée est liée à son scope, sa capture et sa révision ou son
curseur humain propre. Elle n'est publiée complète qu'après toutes ses pages.
Une série partielle ne permet pas d'annoncer zéro demande ni zéro travail.
Les séries humaines et runtime ne partagent pas nécessairement une révision ;
leur cohérence croisée doit venir d'une lecture native attestée. Le type
`NativeFact030` rend les données absentes explicitement indisponibles.
Un contenu humain non classifié reste lisible, avec sa finalité non attestée ;
il n'autorise aucune décision. Les budgets machine sont présentés par travail
attribué, même lorsqu'une seule question en suspend plusieurs.

Les délais affichés proviennent des faits natifs exacts. L'UI n'envoie ni
`nowMs` ni événement d'expiration. `timeoutMs` machine commence à l'admission et
exclut l'union des attentes humaines attribuées. Steer et correction ne le
réinitialisent pas. `approval.timeoutMs` compte l'attente humaine propre à
l'étape. `answerTimeoutMs` décline une demande et reprend le temps machine ;
une réponse reçue exactement à l'échéance perd. La soumission, son arbitrage et
sa remise à l'exécuteur sont trois faits distincts. Une remise réservée mais
non acquittée reste incertaine, sans second envoi automatique.

La demande relue et son reçu conservent la même réponse attestée dans leur
état : choix ou décision et commentaire exacts, ou JSON de question, origine
`person`, `syntheticPerson` ou `automaticTimeout`, et instant monotone natif
`receivedAtMs`. Après résolution, ils portent aussi le reçu de résolution,
`resolvedAtMs`, l'acceptation et le motif `person`, `answerTimeout`,
`approvalTimeout`, `revocation`, `stop` ou `workEnded`. Cet historique reste
immuable dans les états résolu, consommé, expiré, annulé et incertain après
résolution. Une fermeture sans réponse native porte explicitement `null` ;
une réponse personnelle ou un refus automatique `answerTimeout` ne le peut
pas. Le brouillon UI ne remplace jamais cette réponse lors d'une relecture.
Sans ces faits, le raccord reste indisponible, trou G5 à livrer par N-HUMAN.

`RunHumanClock030.observedAtMs` est l'instant monotone d'observation de l'hôte,
dans la même incarnation que `openedAtMs`. À cette observation, le délai humain
restant vaut `max(0, openedAtMs + timeoutMs - observedAtMs)`, avec calcul entier
exact ; `timeoutMs: null` signifie absence de délai. Le natif fournit aussi le
budget machine restant de chaque travail dans `machineRemainingMs`, ou `null`
sans limite. Lorsque `machinePaused` est vrai pendant l'attente humaine, ce
budget ne décroît pas ; le délai humain, lui, continue de courir.

La vue relit ces observations à l'ouverture, au retour de navigation, lors d'un
changement de demande ou de pause, et à chaque rafraîchissement du run visible.
Entre deux observations, elle affiche la dernière durée attestée sans la faire
décroître avec l'horloge du navigateur. Une lecture échouée marque cette donnée
périmée ; elle ne provoque aucune expiration. Les instants de deux incarnations
ne sont jamais soustraits. N-HUMAN doit fournir ces données, trou G11.

Les dates d'historique et la comparaison utilisent la source, son empreinte,
les versions, le profil et la provenance capturés. Une date absente s'affiche
inconnue. Le temps monotone perdu après crash n'est pas reconstitué ; la reprise
transparente des échéances entre générations n'est pas qualifiée.

### DTO natifs à compléter

| Trou | Données ou frontière manquantes | Lot runtime propriétaire et condition de sortie |
| --- | --- | --- |
| G1, qualification | Identité de qualification, plateforme/versions exactes, propriétés admises, diagnostics par agent et liste `unassessed` publique ; lien au registre/source | Fournisseurs lot 2 pour capture/admission, lot 6 pour preuves physiques, lot 7 pour projection. Une compilation réussie ou un module ne suffit pas. |
| G2, livraison | `execution_deliver030` porte capture, identifiant, agent, instance, mode et message ; événement natif dédupliqué et projection de consommation | Raccordé à Codex 0.167.x. UI sur l’instance partagée sans flow ; formes supplémentaires d’interface et continuité entre travaux relèvent du lot 3.4. L’admission historique reste indépendante. |
| G3, humain du vrai flow | Projection publique sur `engine_flow030_human_*`, identité publique et révision natives, associations aux occurrences | Humain U avec N-HUMAN H/B ; I/09 raccorde migration/pump. La commande lit maintenant les tables du flow et publie les faits dans `flowJson`. Le lecteur historique reste séparé. |
| G4, finalité humaine | Discriminant choix de flow / permission d'action, message exact capturé et action réellement présentée | Humain U / N-HUMAN. Le `kind: approval` actuel ne justifie pas de choisir l'un des deux dans l'UI. |
| G5, reçu et historique humains | Nouvelle commande publique, réponse attestée relisible sur demande et reçu, choix/commentaire ou JSON exact, origine et instant natifs ; motif et reçu de résolution conservés après consommation, expiration, annulation ou incertitude | N-HUMAN H/B avec humain U pour la projection ; I/09. Les états sans cet historique restent indisponibles. Ne pas reprendre la révision historique calculée par addition de deux booléens. |
| G6, question | Schéma/protocole public attesté, disponibilité du validateur natif, refus typé sans validateur | Humain U / N-HUMAN, N-CALLS pour identité/port MCP. Le JSON public ne reconstitue pas le validateur natif. |
| G7, arrêt | Reçu Stop public relisible, progression physique, confirmation attestée et incertitude | Fournisseurs lot 5 et N-OBS ; I/09. `stopping` et `physicalPending` ne suffisent pas à fabriquer un reçu `stopped`. |
| G8, diagnostic | Lecture 0.3 paginée, code/message d'origine, occurrence, cause, handler, disposition et effets connus | N-OBS avec fournisseurs lot 5 et terminaux N-HUMAN/N-CALLS. Le lecteur historique `execution_read_diagnostic` ne prouve pas cette couverture. |
| G9, occurrence et chronologie | Message/émetteur réellement reçus, output exact, visite, appartenance au flow, provenance et dates attestées | N-OBS ; N-CALLS et N-HUMAN fournissent leurs reçus, livraison lot 3 fournit ses identités. La projection actuelle fournit déjà activation, instance, groupe et chemins. |
| G10, incertitude | Identité publique du fait ambigu, scope/révision, reçus corrélés et issue de réconciliation sans capacité de replay | Fournisseurs lots 1/5 et N-OBS ; I/09 expose la lecture proposée. L'absence de ligne ne débloque pas un claim ambigu. |
| G11, observation d'horloge | `observedAtMs` monotone natif, budget machine restant par travail et état de pause, cohérents avec la demande et la même incarnation | N-HUMAN H/B avec humain U pour la projection ; I/09. Une navigation déclenche une nouvelle observation, sans reconstruire le temps depuis l'horloge du navigateur. |
| G12, demande humaine et occurrence | Conversion native attestée de chaque UUID public `workId` vers le scope de capture et `activationId` runtime ; état `unavailable` explicite si ce lien manque | N-HUMAN pour la projection, I/09 pour le raccord commun. Les lots UI 7/8 consomment ce DTO sans déduire la correspondance depuis les identifiants existants. |

Pour intégrer une action, son propriétaire runtime fournit DTO Rust, refus
fermés, relecture idempotente et tests de concurrence/perte d'acquittement. I/09
enregistre la commande et régénère les types IPC. Les lots UI 6 à 9 raccordent
alors transport, store et vue ; le lot UI 11 vérifie les parcours natifs et
visuels du seul profil promis. Les preuves de N-HUMAN et N-CALLS synthétiques
restent distinctes d'un fournisseur réel, d'un sandbox système et d'une vraie
inférence. Cette livraison de contrat n'ouvre aucune commande produit.
