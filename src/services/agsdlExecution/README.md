# Conformité et raccords natifs AgSDL inline

Le compilateur pur évalue le profil `macro-serial-inline-v1`. Les raccords natifs
et `ResidentAgent` ajoutent les frontières privées d’exécution.
`PRODUCT_RUNTIME_AVAILABLE` et `CompilationResult.productRuntimeAvailable` restent
`false` jusqu’à l’intégration et à la qualification du host et de Flow.

## Versions et représentation

- Contrat normatif `agsdl-0.2.0`, publication
  `ae478d6203dd1571af064317238fd0a0f7dece75`.
- Compilateur `macro-agsdl-inline-compiler/1`.
- Contrôles locaux `macro-agsdl-conformance/1`.
- Plan `macro-agsdl-compiled-plan/1`.
- Publication `macro-agsdl-publication/1`.

`decode` vérifie aussi le champ d'erreur du scanner vendor. `encode`, `equal`,
`shape`, `satisfies` et `NumberToken` conservent les nombres exacts. Les valeurs
AgSDL ne passent ni par `JSON.parse` ni par `structuredClone`. Les JSON ordinaires
utilisés pour comparer les schémas du registre Macro et les descriptors MCP
proviennent des contrats typés existants, jamais des valeurs authored.

`CompiledPlan` conserve le document exact, ses déclarations et settings, les
adresses tableaux, les routes normales et d'erreur, les tokens `maxVisits` et les
configurations développées. `compiledPlanJson` est le transport durable proposé.
Les JSON de ses champs restent des chaînes exactes. Le propriétaire natif doit
valider ce format et ses versions avant d'appliquer son autorité de routage.
Un `maxVisitsJson` reste un entier mathématique JSON, par exemple `1e20`.
Le natif le convertit sans perte en compteur décimal canonique.

## Format pour l'autorité de routage native

Le JSON externe est un objet `CompiledPlan` au format
`macro-agsdl-compiled-plan/1`. Ses valeurs de déclaration sont des chaînes JSON
exactes. La désérialisation native doit préserver cette distinction et contrôler
le format, les versions et l'association au snapshot capturé.

| Champ | Lecture native |
| --- | --- |
| `documentJson` | Document authored complet sérialisé sans arrondi, avec bindings, interfaces et configurations. Les octets authored originaux et leur SHA restent dans le snapshot. |
| `entry` | Adresse tableau d'un step, ou `null` pour absence de flow. |
| `steps[].address` | Adresse complète et distincte du step. |
| `steps[].declarationJson` | Déclaration exacte complète, dont type, delivery, scope, arguments, test, decision et politiques authored. |
| `steps[].maxVisitsJson` | Token entier mathématique exact, ou `null` si absent. |
| `steps[].routes.normal` | Route ordinaire d'un Agent sans décision, Call ou Prepare. |
| `steps[].routes.true/false` | Routes d'une Condition, sélectionnées par l'évaluation exacte de son test. |
| `steps[].routes[choice]` | Route d'un Agent avec décision, sélectionnée après validation complète des outputs et du choix. |
| `steps[].errorRoutes` | Route `onError`, distincte de toutes les routes normales. |
| `agents[]` | Configurations capturées, contenu développé, settings exacts, provider/model et plafonds de permissions/scope. |
| `steps[].publicationContractJson` | Contrat de publication typée de ce step, ou `null`. |
| `graphlessPublicationContracts` | Contrats de sorties nommées sans graphe, indexés par Agent. |

Chaque route est un tableau d'adresses, par exemple `[["recover"]]`.
Le premier profil en autorise zéro ou une. Une route vide termine ce chemin.
L'interprétation de `routes` dépend du type et de la décision conservés dans
`declarationJson`, donc un choix authored nommé `normal` reste un choix explicite.

Le futur adaptateur natif relie ce format au trait synchrone
`RouteAuthority.outgoing` de Durability. Il contrôle les destinations contre le
snapshot, l'adresse source et l'unique issue terminale retenue. Il vérifie aussi
la cohérence des champs compilés avec leur déclaration exacte avant de les
utiliser. Une liste outgoing envoyée par le host n'établit jamais à elle seule
une destination autorisée. `selectedRoute` valide une completion Agent avant de
choisir la route ; `conditionResult` choisit true/false en conservant l'origine.
Ces fonctions sont consultatives pour l'autorité native et ne dispatchent rien.
Le trait Rust et ses conversions restent à réaliser dans Hosting avec le
coordinateur.

## Raccord du futur host

1. Le natif lit la source canonique du plan, contrôle son propriétaire et sa
   révision, puis fournit `SourceRevision` et un `CapturedRegistry` authentifié
   au host résident. La révision actuelle est celle du fichier metadata du plan,
   pas une révision interne AgSDL. Aucun helper local ne prouve le propriétaire
   ni la fraîcheur du fichier.
2. `compilePlan` valide et copie synchroniquement les champs de source et du
   registre avant toute attente. Il valide le document vendor, revérifie le SHA-256
   des octets UTF-8 et contrôle le profil et toutes les configurations Agents.
   Il renvoie séparément `static` et `runtime`. `supported` devient true seulement
   après construction, sérialisation exacte et contrôle lexical du plan sérialisé.
   Tout refus reste non supporté, sans plan ni `compiledPlanJson`.
3. Avant une livraison, `validateOrigin` puis `deliveryMessage` et `validateInput`
   contrôlent la frontière. `prepareMessage` applique seulement les sélecteurs de
   l'entrée courante. `conditionResult` conserve la même valeur et son origine.
4. Avant un Call, `prepareCall` vérifie le binding, l'origine, les arguments exacts,
   leur schéma et le scope évalué. Le host effectue ensuite les contrôles Macro
   réels, enregistre l'effet dans le repository natif et réutilise le dispatch.
   `validateRegisteredResult` ou `callResult` contrôlent le `data` retourné.
5. Pour un Agent, l'adaptateur réutilise `streamingChat` et `toolCallingLoop`.
   Il fournit uniquement les Messages visibles complets de l'activation aux
   méthodes `append` et `publish` de `ExactResponseCollection`. Il exclut lui-même
   reasoning, échanges bruts d'outils et historique. Le collecteur ne prétend pas
   déduire ces catégories de chaînes arbitraires.
6. La collection doit fermer avant le commit terminal. `validateCompletion`,
   `completionResult` et `selectedRoute` contrôlent les sorties requises et le
   choix avant une continuation. Le natif conserve la terminaison, la mémoire,
   le curseur et les livraisons dans une transaction unique.

La frontière de métadonnées exige des chaînes primitives pour les identités,
versions et JSON exacts. Une identité vide ou composée seulement d'espaces est
refusée ; le contrôle conserve tout texte accepté sans le réécrire. La révision
source est un entier décimal canonique non négatif sans limite de précision et
le SHA est une chaîne de 64 caractères hexadécimaux minuscules. `captureRegistry`
vérifie les conteneurs, les bindings, leurs capacités et preuves, les entrées du
catalogue Model, les configurations et les descriptors MCP. Ces contrôles de
forme ne prouvent toujours pas la provenance native du registre.

`RuntimeAssessment.source` peut être `null` uniquement si la capture source est
structurellement invalide. Ce refus porte `CORRELATION` et un pointeur sous
`/source`, sans recopier l'entrée malformée. Une source valablement capturée reste
complète dans les refus ultérieurs, notamment un SHA différent, un registre
incomplet ou un profil hors périmètre. `registryVersion` est vide quand aucune
version de registre n'a été capturée. Ces absences représentent un refus, jamais
un propriétaire ou une version de remplacement. Le host doit refuser tout
assessment sans source avant une ouverture durable. `CompiledPlan.source` et
`SystemSnapshot.source` restent complets et obligatoires ; un succès conserve
une source complète. Seuls les champs déclarés des DTO sont copiés, sans
propriétés supplémentaires ou valeurs non transportables provenant du caller.

`toDispatchValue` est une conversion facultative pour les DTO ordinaires du
registre Macro actuel. Elle exige que chaque nombre converti ait exactement la
même valeur décimale JSON après aller-retour. Elle refuse dépassement, perte de
précision et arrondi avant un effet. Elle ne remplace pas le stockage exact.

## Registre capturé et limites de confiance

`CapturedRegistry` est une entrée de l'adaptateur de confiance du démarrage natif.
Ce module pur ne constitue pas un service d'authentification. Une construction
frontend du même objet ne donne aucun droit d'exécuter un effet. Aucun champ
`supported` ni claim authored ne produit une attestation.

Chaque `BindingAttestation` correspond par égalité JSON exacte à la déclaration
complète, donc aux éditions contract et implementation, settings, effects et
requirements. Les capacités vérifiées du chemin et les requirements complets
sont des observations de l'autorité future. Des paramètres absents diffèrent
bien de `{}`. Aucun ordre de versions, sous-ensemble ou claim d'un Tool ne prouve
la configuration Agent entière.

Le binding sélectionne explicitement un adaptateur Macro, un identifiant Tool
présent dans `MACRO_TOOL_REGISTRY`, ou un couple serveur/Tool MCP et son descriptor
capturé. Les arguments des Tools Macro doivent conserver leur schéma réel.
Les descriptors MCP doivent provenir de la découverte typée Macro. Leur schéma
de résultat et leurs contrôles d'accès restent des attestations de l'adaptateur,
car le DTO `MCPTool` actuel ne fournit pas ce contrat de sortie. Une absence de
preuve bloque le chemin.

Le catalogue MCP conserve les identifiants littéraux issus de la découverte.
`captureRegistry` et `resolveBinding` réutilisent `assertUniqueMCPToolIds`, le
helper pur de Macro. Deux descriptors avec le même ID sont refusés globalement,
même sur des serveurs distincts, même identiques et même désactivés. Le contrôle
précède le filtre du binding par serveur et activation ; aucun ID n'est normalisé.
Ce refus donne `UNSUPPORTED` sous `/registry/mcpTools`, sans recopier le message
brut qui contient les noms des Tools. Des IDs distincts restent acceptés dans
le même serveur ou entre serveurs ; un Tool sélectionné désactivé reste refusé.

Les identités de catalogue utilisées doivent également être univoques : une
seule édition correspondant au modèle authored, un seul couple natif provider/
model pour le modèle sélectionné, et une seule attestation de configuration
pour chaque Agent capturé. Les déclarations complètes de bindings doivent garder
leur unique attestation, par égalité JSON exacte indépendamment de l'ordre des
clés. Le même modelId sur des providers différents reste une identité distincte.
Ces contrôles ne créent pas de catalogue parallèle ni de preuve native.

Le catalogue Model capturé doit fournir une édition explicite, un provider et
un modèle uniques. `ConfigurationAttestation` doit correspondre à l'Agent et à
sa configuration authored et couvrir les requirements de configuration et des
skills. Les champs de credentials sont refusés dans les settings authored des
bindings et configurations et dans les settings effectifs du registre natif.
Ce contrôle ne traite pas les noms de propriétés de valueSchema, de ressources
ou de résultats comme des secrets. Les données publiques conservent leurs clés
et leurs valeurs authored. L'autorité native reste responsable de garder ses
credentials réels dans les services sécurisés Macro.

Les settings effectifs, permissions et scope sont capturés sans secrets.
Les vérifications de droits actuels et les approbations Macro restent nécessaires
à chaque invocation réelle.

Le validateur d'arguments couvre le sous-ensemble effectivement utilisé ici,
`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`,
`minLength`, `allowEmpty` et `description`. Tout autre keyword MCP bloque le
préflight. Les résultats utilisent le langage fermé `valueSchema` AgSDL, vérifié
avec les règles vendor. Aucun validateur JSON Schema général n'est annoncé.

Le dispatch Macro ajoute sa propre politique dans `validateToolArguments`.
Une chaîne requise qui ne contient que des espaces y est absente, sauf
`allowEmpty: true`. Par exemple, le schéma de `web_search` admet `query: "   "`
par sa longueur, mais le validateur Macro réel refuse cet argument. Hosting doit
exécuter ce validateur après la conversion exacte `toDispatchValue`, avant tout
effet Macro, en plus du contrôle de schéma et des permissions. Cette politique
ne s'applique pas automatiquement aux schémas MCP. Les données authored conservent
tous leurs espaces et ne sont pas réécrites pour faire passer la validation.

Les codes des helpers de lecture et de records, comme `PARSE` et
`INVALID_RECORD`, ne sont pas tous des codes terminaux AgSDL. Hosting mappe les
erreurs à la frontière concernée vers les codes normatifs avant de former un
`ErrorInput` ou d'emprunter `onError`.

## Protocole de publication

Le plan contient `publicationContractJson` par step Agent et
`graphlessPublicationContracts` pour les sorties nommées sans graphe. Le contrat
explicite contient le protocole/version, la version du registre, l'Agent,
l'adresse ou `null`, l'Interface complète, les choix et le binding de décision.
Ce contrat est injectable dans le futur adaptateur. Il exige une capacité
`typed-publication` vérifiée du chemin Engine et un binding de décision explicite
lorsque le step décide.

L'adaptateur reçoit ce contrat lors de la configuration de son canal de
publication typé. Une publication transporte `TypedPublication` avec ce contrat
exact, son attribution au work et à une tentative fournisseur enregistrée,
son identité stable, sa séquence d'émission, `resultsJson` et un choix ou `null`.
Le canal doit conserver `resultsJson` comme chaîne exacte, ou lire les arguments
provider bruts avec le scanner exact avant la publication. Un callback qui a déjà
converti les arguments en nombres JavaScript peut avoir perdu la précision ;
`toDispatchValue` ne détecte pas une perte survenue avant son entrée.
Aucune phrase de sortie ne devient une publication. Un résultat doit être nommé
par l'Interface, respecter son format et son `valueSchema`. Le choix doit être
déclaré. Plusieurs publications peuvent compléter des résultats distincts,
mais une seconde occurrence d'un même résultat ou choix est ambiguë et refusée.

Chaque Message et chaque publication exigent un `providerAttemptId` explicite,
non vide et présent dans les tentatives enregistrées. Omission, undefined et
identifiant inconnu donnent `CORRELATION` avant toute insertion. Une collection
sans tentative peut fermer sans émission ; elle ne peut accepter aucun événement.
La clôture vérifie son contexte sans prendre l'identité d'une émission fournisseur.

Séquences, curseurs et epochs exigent une chaîne primitive décimale canonique.
Les `number`, `bigint`, objets `String` et valeurs omises ou `undefined` sont refusés
avant signature ou insertion, sans consommer la séquence. Les pointeurs d'erreur
sont `/sequence`, `/cursor` et `/ownerEpoch`. Les séquences sont positives et
communes aux Messages et publications. Elles commencent à `1`. Les événements
peuvent arriver dans le désordre, mais la fermeture exige la continuité jusqu'au
curseur inclus. `0` ferme une collection vide. Les retransmissions identiques avant fermeture sont idempotentes. Les
conflits, trous, mauvaises attributions et émissions après fermeture échouent
avec `CORRELATION`. Une fermeture répétée au même curseur conserve le résultat.
Les bornes par défaut sont 10 000 événements et 2 000 000 octets de texte visible.
Elles bloquent une collection trop grande sans tronquer ses sorties.

Le collecteur exact reste pur et en mémoire. `retainedResponses` le reconstruit
à partir du journal SQL natif, puis fait clôturer le curseur et le digest par le
repository. Le contrôle natif exige la fin des effets enregistrés. Une erreur
de transport, un trou de séquence ou un reçu absent ne deviennent pas une simple
violation de contrainte de sortie.

## Raccords Hosting en cours

`agsdl_host_capture` capture le plan canonique sous les verrous de metadata,
le catalogue effectif et les configurations natives. La webview dédiée exécute
ce compilateur avec un ticket lié aux octets, à la source et à sa génération.
Preflight n’admet aucun travail ; Start revalide la capture jusqu’au commit SQL.
Une livraison externe exige un système sans graphe et un Agent capturé. Ses
identités d’activation proviennent du natif ; un réessai conserve le reçu exact.

`ResidentAgent.prepare` initialise la mémoire avant l’adaptation Flow.
`executeReady` appelle le moteur Macro partagé avec des ressources propres à
l’activation, sans conversation ni Task artificielle. Les tentatives passent par
les ports privés register/dispatch/end. Les textes originaux et arguments de
publication sont journalisés avant la présentation ou la conversion des nombres.
Un reçu ambigu interdit la clôture. La mémoire reste provisoire jusqu’au témoin
terminal natif ; l’Agent ne choisit ni n’insère une liste libre de successeurs.

Le profil OpenAI-compatible conserve chaque alias authored et refuse ceux qui ne
respectent pas `[A-Za-z0-9_-]{1,64}`. Cette borne relève de l’évaluation runtime,
pas de la syntaxe générale AgSDL. Le loop vérifie à nouveau cette borne avant
la requête fournisseur.

Les liens de cartes conservent les associations explicites capturées. Le port
Task relit les identités, le projet et la cible native au clic ; une preuve
absente ou ambiguë donne `null`. Il ne déduit aucun lien du titre et ne reporte
pas une Task globale sur toutes les cartes.

Les adaptateurs Tool/Call workspace passent par le registre Macro existant.
Leurs arguments exacts et leur scope évalué restent distincts du plafond natif.
La réservation durable précède l’admission physique, avec les verrous de source
et de politique conservés jusqu’à la fin de l’exécuteur. Stop demande l’arrêt ;
le reçu ended attend la fin réelle de l’opération, y compris ses travaux natifs.
Un échec terminé conserve un résultat exact marqué failed ; une perte de preuve
reste uncertain. Terminal et MCP restent exclus de ce profil.

Les approbations pending/decide sont natives et survivent à la navigation.
L’UI fournit seulement run, source, approvalId et décision. La consommation et
la réservation d’effet vérifient le travail, l’owner et Stop dans la transaction.
Une Task de Start est facultative et doit désigner une cible Macro réelle.

Le superviseur natif révoque l’incarnation perdue avant de recréer le webview.
Le nouveau host réattache les captures conservées seulement si la compilation
et les versions correspondent exactement. Les effets inconnus ne sont pas
rejoués. Le port privé mark_uncertain vise un travail, sans arrêter les autres
Agents. Les diagnostics publics permettent une sélection exacte ou une page
récente bornée et ne révèlent pas la capture privée.

Ces raccords restent soumis à la QA du host réel. La disponibilité produit
reste false ; la pompe et l’ordonnancement appartiennent à Flow.

## Vérifications

Les tests ciblés couvrent les frontières de rôles, précision numérique,
contraintes, refus du profil, bindings et collecte. Le test différentiel
`referenceConformance.test.ts` accepte `AGSDL_REFERENCE_DIR`, un checkout local
AgSDL 0.2.0. Il compare delivery, completion, préparation et expansion avec les
helpers Python publiés. Pour Condition, il applique les règles normatives avec
leurs fonctions officielles `operand_value` et `equal`, car la publication ne
fournit pas de helper Python d'exécution Condition autonome. Sans cette variable,
ce seul test différentiel est explicitement ignoré. Il n'effectue aucun réseau.

Les ports de contenu et contraintes dérivés de `sources.py`, `check_delivery.py`
et `check_completion.py` portent leur attribution Apache-2.0 en tête de module.
Le NOTICE et la licence du lecteur vendor restent conservés.


## Parcours privé de qualification

En développement, `agsdl-host-qa.html` expose un formulaire manuel, refusé par
le natif hors build `browser-runtime-debug` et identifiant de profil QA isolé.
Un profil de navigateur à liste explicite de capabilities doit inclure
`agsdl-host`, qui autorise uniquement l’écoute des événements dans le host.
La page utilise les ports publics pour Preflight, Start graphless, Deliver,
approbations, Stop et projection. Elle ne reçoit aucune epoch.

Le déclenchement manuel transmet une livraison graphless existante à un slot
natif de qualification. Seul le host authentifié peut le consommer ; un événement
JS seul ne donne aucune autorisation. SQL begin reste propriétaire de l’admission.
Le helper exécute un ResidentAgent et son témoin terminal sans parcourir une
file ni démarrer la pompe Flow. La boucle compilateur reste disponible pendant
cette exécution. La commande de remplacement QA emprunte le vrai chemin natif
de révocation et de recréation, et non une simulation de propriétaire.

Le formulaire n’est pas une entrée du build produit. Sa validation visuelle et
les scénarios reload, perte du host et arrêt des IO exigent le runtime isolé réel.


## Pages de projection publique

`execution_read_projection` accepte `page: null` pour la première page, puis
le `nextPage` exact renvoyé par le natif. Chaque page contient au plus 64 Agents
et 64 activations, terminaux compris. Les deux collections suivent l’ordre de
leurs clés natives BTreeMap, respectivement nom d’Agent et identité d’activation.
Le même offset est appliqué aux deux collections ; une collection épuisée reste
vide sur les pages suivantes. `nextPage: null` indique la fin, toute autre valeur
signale explicitement un résultat partiel. `cursor` est la frontière durable.

Une continuation exige le même curseur durable. Si le run avance, le natif refuse
la page obsolète et le client doit demander explicitement une nouvelle première
page, sans fusionner les fragments de deux curseurs. Il n’existe pas de fallback
vers un état mutable. `HostInspection`, privé, conserve son contrat intégral.
Le wrapper public transmet la continuation sans construire de snapshot local.

La page d’événements lit état et journal dans une transaction SQLite commune,
refuse un `after` futur et limite la sélection au curseur durable de ce snapshot.
Relire exactement ce curseur renvoie une page vide avec ce même curseur.
