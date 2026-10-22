# Macro Connect entre appareils

Statut : proposition d'architecture, sans changement du protocole ni du runtime.
Les opérations et noms de composants futurs ci-dessous ne sont pas des API disponibles.
Les contrats existants restent la source de vérité du comportement livré.

Révision du 22 octobre 2026 : les réserves F1, F2 et F3 de la relecture de cette
proposition sont traitées dans la conception. Les garanties restent à prouver
par l'implémentation. Le [plan de réalisation](macro-connect-implementation-plan.md)
fixe les lots, leur ordre et leurs critères de fin. Pour le transfert, lire aussi
la [machine à états et les règles de cession](macro-connect-transfer-design.md).

## Besoin et décision

Macro Connect doit permettre à un téléphone de consulter et piloter plusieurs
ordinateurs, et à un ordinateur de faire la même chose tout en continuant son
travail local. Il doit aussi permettre de transférer une conversation existante
vers un autre ordinateur avec son historique et d'y poursuivre le travail.

Chaque ordinateur reste propriétaire de ses données et de ses exécutions.
Le relais transporte le contenu à la demande, sans conserver d'historique de
conversation durable. Un transfert crée une conversation locale sur la destination.
Il ne rend pas les bases de tous les ordinateurs répliquées entre elles.

Trois actions ont des effets différents :

| Action | Emplacement des données et de l'exécution |
| --- | --- |
| Ouvrir une conversation distante | La conversation reste sur l'ordinateur source. Les actions lui sont adressées. |
| Créer un chat ou lancer une tâche à distance | L'ordinateur choisi crée ou exécute la ressource dans son propre environnement. |
| Transférer une conversation | La destination importe un historique vérifié. La source conserve une copie et cède la poursuite du travail après une décision durable. |

Le premier transfert couvre uniquement un Chat sans portée projet ni groupe,
sans tâche, à l'arrêt et sans interaction ou instruction en attente. Un Chat peut
déjà être lié à des projets dans Macro : son seul `scope_mode` ne prouve donc pas
sa portabilité. Le précontrôle examine la portée durable et toutes les dépendances
avant de réserver ou suspendre la source. Un contexte incompatible est refusé
explicitement, sans détacher silencieusement le chat de son projet.

La prise en charge des Chats avec portée projet, puis d'Architecte et
d'Implémentation, reste un lot distinct du chantier. Elle ajoute l'association
du contexte local, des plans et tâches et les préconditions Git. La capacité
annoncée doit distinguer ces variantes ; aucun repli vers le transfert sans
projet n'est permis.

## Ce que Macro possède déjà

Le [runtime producteur](../src/services/macroPilot/runtime.ts) expose une instance
desktop locale avec les stores et services existants. La
[composition desktop](../src/composition/macroPilotDesktop.ts) lui injecte ces
sources locales. Le relais n'exécute ni les fournisseurs ni les outils.

Les [identités du client natif](../src/services/macroPilot/nativeClient.ts) séparent
compte, session d'appareil, instance et droit d'accès. Le
[protocole de commandes](../src/services/macroPilot/protocol.ts) distingue l'acteur
émetteur de l'instance cible. Le type d'appareil est une métadonnée d'affichage,
sans pouvoir d'autorisation. Le même compte permet le rattachement automatique
prévu par le produit, en respectant les refus et révocations déjà enregistrés.

Le [contrat v2](macro-pilot/content-contract-v2.md) sépare ACCOUNT du contenu par
instance, avec négociation de capacités, captures, révisions, événements et limites
d'octets. Le [contrat de fiabilité](macro-pilot/network-reliability-contract.md)
fournit déjà des lectures conditionnelles et des révisions de conversation.

Les [actions desktop](../src/services/macroPilot/desktopActions.ts) savent démarrer
une tâche existante sur son hôte. Les
[opérations de conversation](mobile-conversations-contract.md) permettent la
lecture paginée et la création d'un chat neuf. Elles ne fournissent pas d'import
intermachine d'une conversation existante.

Le [transport remote expérimental](../src/services/providers/remote.ts) dépend
d'une sélection globale de fournisseur de services. Il est incomplet et son
authentification ne représente pas les droits Macro Connect. Son exposition comme
API entre PC ou son utilisation pour basculer toute l'application vers un autre
ordinateur ne convient pas. Les services métier du kernel peuvent être réutilisés
derrière les contrôles Macro Connect, en conservant leurs validations natives.

## Un producteur local et plusieurs connexions clientes

Un desktop conserve son unique runtime producteur local. Un gestionnaire de
connexions clientes distinct maintient les liens vers les autres instances.
Consulter un PC distant ne remplace jamais le fournisseur de services local et
n'arrête pas la publication de cette machine.

Chaque ressource distante est adressée par origine relais, incarnation du compte,
instance propriétaire et référence de ressource. Un identifiant de conversation
seul ne suffit pas. Les caches, brouillons, sélections et reçus gardent cette
portée, même lorsque l'interface affiche une liste unifiée.

Une connexion cliente est partagée par ses abonnés. Elle possède une génération,
des annulations, un ordonnanceur, des capacités négociées et une stratégie de
reprise propres à l'instance cible. Un changement de session, de droits ou de
producteur invalide les références qui en dépendent. Les secrets ne figurent ni
dans les clés de cache ni dans les diagnostics.

Le desktop a besoin d'un transport consommateur typé, équivalent au rôle déjà
utilisé par le mobile. Il doit être distinct de `requestContent` dans le client
natif actuel, qui borne les livraisons producteur à l'instance locale. La clé
d'instance reste exclusivement une preuve du producteur local. Une requête vers
un autre PC utilise la session de l'émetteur et les droits sur la cible.

Les règles d'autorité restent indépendantes des capacités annoncées. Une machine
qui annonce une opération ne donne pas pour autant le droit de l'exécuter.
Les extensions doivent passer par le contrat canonique, ses validateurs et ses
fixtures, puis être importées dans le relais et les clients. Les anciennes
enveloppes restent compatibles.

Le transfert exige des droits distincts sur l'export source, l'import cible et
l'activation. Leurs règles et leur correspondance aux permissions existantes
doivent être fixées dans cette extension canonique. Un droit de lecture ou une
annonce de capacité ne doit pas autoriser implicitement une importation active.
La décision de cession vérifie les deux droits, les générations et les reçus
courants. Une reprise après réauthentification revalide ces preuves.

## Optimisations adaptées à Macro

L'étude de T3 Code suggère des mécanismes utiles, mais ses seuils, ses dépendances
de transport et son organisation des données ne constituent pas un contrat Macro.

| Mécanisme | Application retenue pour Macro |
| --- | --- |
| Supervision de connexion partagée | Une connexion cliente par cible, partagée par les écrans. Reconnexion temporisée avec dispersion aléatoire, annulation et distinction entre panne de transport et refus d'autorité. |
| Résumés séparés du détail | Catalogues et cartes pour les listes. Historique, pièces jointes, traces et réflexions lus seulement pour la conversation ouverte ou une demande explicite. |
| Reprise par curseur | Conserver un curseur après application des données. Reprendre si la continuité et les droits sont valides. Un trou de journal déclenche une resynchronisation bornée de la ressource concernée. |
| Coalescence des mises à jour | Regrouper les mises à jour de texte et d'activité avant émission. Conserver l'ordre des états terminaux, des interactions et des reçus de mutation. |
| Cache et virtualisation | Budgets globaux et par instance, éviction des ressources inactives, historique paginé automatiquement au scroll. La virtualisation visuelle ne remplace pas un plafond des données retenues. |
| Télémétrie à la demande | Mesurer CPU et RAM uniquement lorsque des abonnés en ont besoin, avec fréquence réduite pour les cartes non visibles. Les erreurs et les machines hors ligne ne deviennent pas des mesures à zéro. |

Le transport actuel de lectures conditionnelles et d'attentes HTTP d'événements
reste le point de départ. Une connexion persistante ne mérite son coût que si les
mesures montrent un gain sur réseau mobile et plusieurs PC simultanés. Les règles
de reprise doivent fonctionner indépendamment du choix HTTP ou WebSocket.

Certaines décisions de T3 Code répondent à une autre architecture :

| Élément étudié | Choix pour Macro |
| --- | --- |
| Orchestrateur événementiel et projections propres à T3 Code | Conserver SQLite, les journaux de mutations et les services Macro. Ajouter les invalidations manquantes sans réécrire l'orchestrateur. |
| Runtime TypeScript et caches de sa pile frontend | Partager le contrat et les scénarios de reprise entre desktop TypeScript et mobile Dart ; conserver une implémentation adaptée à chaque cycle de vie. |
| Routes de connexion et tunnels de son déploiement | Garder l'identité et les droits du relais Macro. Une route locale future devra prouver la même identité et les mêmes droits avant de recevoir des données. |
| Relecture de messages par tours complets et caches par conversation | Conserver les plafonds d'octets Macro et ajouter une limite cumulée entre instances. Mesurer aussi les pages chargées hors écran. |
| Sessions internes d'adaptateurs de fournisseurs | Reprendre avec les adaptateurs Macro de la destination et un contexte dont la portabilité a été vérifiée. |

### Réduire le travail avant de réduire les octets

La boucle actuelle du [host de contenu](../src/services/macroPilot/contentHost.ts)
observe régulièrement les ressources. Les captures de conversations peuvent
relire des messages pour établir une empreinte cohérente. Remplacer les lectures
répétées par des notifications de mutation après commit peut économiser des accès
SQLite et des sérialisations, même si le nombre de requêtes HTTP change peu.

La notification doit provenir des points d'écriture durables et du runtime pour
l'activité transitoire. Un listener de store UI seul manquerait les mutations
natives ou externes. Les révisions existantes restent l'autorité. Un journal
borné d'invalidation et une revalidation de secours doivent couvrir les événements
perdus, les redémarrages et les écritures qui échappent aux notifications.
La capture conserve ses contrôles de cohérence, de politique et de révocation.

### Répartir les ressources entre appareils

Les mutations interactives et la conversation visible passent avant les résumés
hors écran et les préchargements. Des plafonds par cible et un plafond global
limitent les requêtes, buffers et captures. Une machine lente ne doit ni bloquer
les autres ni monopoliser la mémoire.

Au retour du premier plan, le client revalide l'identité, les droits et la
continuité. Il conserve les données encore autorisées en lecture seule pendant
une panne réseau. Une révocation entraîne le retrait des données protégées et
l'annulation des requêtes. Un délai de cache n'est jamais une durée d'autorisation.

Pour le premier lot, seule la RAM du processus est concernée. L'affichage hors
ligne reste borné à 30 secondes au maximum après la dernière vérification des
droits, par l'échéance d'autorité reçue et par l'expiration actuelle de la capture.
La durée est décomptée dès le départ de la demande avec une horloge monotone ;
le délai réseau la réduit. Le client ne prolonge aucune des deux par une activité
locale. Il verrouille les données si cette preuve manque ou expire. Une révocation distante
n'est détectable qu'après un échange réussi ; le produit ne promet pas un effacement
instantané pendant une coupure. Les actions restent désactivées jusqu'à revalidation.

Une mutation dont la réponse est perdue est réconciliée par son reçu sur la même
instance. Le client ne la rejoue pas sur un autre PC. La clé d'intention reste
stable pendant cette réconciliation, même si l'identifiant HTTP change.

## Transférer une conversation existante

### Historique portable et contexte d'exécution

L'[export d'archive](../src/components/chat/ConversationArchive.tsx) produit un
document de consultation. La [sauvegarde de profil](local-profile-backup.md)
remplace un profil entier. Aucun des deux n'est un format d'import intermachine
sûr pour une conversation isolée.

Le futur paquet doit sélectionner explicitement les champs autorisés. Il contient
un manifeste versionné, les messages et citations exportables, les assets retenus,
leur taille et leur empreinte, ainsi que la révision source scellée. Il distingue
les ressources obligatoires des ressources facultatives. La destination attribue
ses propres identifiants et conserve une correspondance d'origine pour les liens
et citations. Les chemins source deviennent des références à résoudre, pas des
chemins automatiquement fiables sur la destination.

Le parseur d'import traite le paquet comme une entrée non fiable. Il borne aussi
la taille totale, le nombre de messages et d'assets et les octets décompressés.
Il rejette les traversées de chemin et conserve les rôles d'origine des messages.
Un contenu historique ou une trace d'outil ne devient pas une instruction système
ni une autorisation locale. Les blocs se valident au fil de l'eau, sans charger
tout l'historique en mémoire avant l'import.

Les sessions fournisseur, secrets, terminaux, verrous et captures d'autorisation
ne suivent pas. Les traces historiques ne deviennent pas des appels exécutables.
Une demande d'autorisation en attente ne vaut jamais accord sur la destination.
Un outil dont l'effet est inconnu bloque la cession jusqu'à réconciliation.

La destination reconstruit le contexte du modèle avec ses propres adaptateurs.
Elle vérifie le fournisseur, le modèle, les pièces jointes et la fenêtre de
contexte disponibles. Les données de reprise natives d'un fournisseur ne sont
acceptables que si un adaptateur en prouve la portabilité. Sinon, la reprise
utilise l'historique normalisé et annonce ses limites avant validation.

Le format doit aussi traiter la compaction et les dépendances de contexte caché.
La simple copie des messages visibles peut perdre les décisions déjà condensées.
Le précontrôle doit identifier ce manque et proposer un contexte portable soumis
à la politique d'export, ou refuser la reprise fidèle. Les données privées et
réflexions internes ne sont pas exportées par défaut pour combler ce manque.

### Préparer, sceller, importer puis céder

La [conception du transfert](macro-connect-transfer-design.md) fixe l'autorité
de décision, l'exclusivité par conversation source, les transitions atomiques et
les règles de récupération. Le relais arbitre la confirmation et l'annulation
sur des métadonnées durables. Chaque PC conserve sa réservation et ses reçus
locaux. Un timeout ne libère ni la source ni la destination quand la décision
est inconnue. Aucun contenu de conversation n'est persisté sur le relais.

La préparation cible reste inactive jusqu'à une cession confirmée. La source
conserve ensuite une copie en lecture seule et un lien vers la destination.
Le gel couvre toutes les admissions locales et distantes, les reprises et les
effets en vol. Les réservations en mémoire existantes ne suffisent pas.

### Ce que voit l'utilisateur

L'action "Transférer vers un autre ordinateur" choisit une machine et affiche
les éventuelles dépendances manquantes dans un seul parcours. La destination
devient active après confirmation durable. Aucun message ni appel fournisseur
ne part automatiquement pour tester la reprise.

Le téléphone peut initier et suivre cette opération, mais les blocs passent entre
les deux ordinateurs via le relais. Le téléphone ne télécharge pas l'historique
complet pour le réémettre. Si la source est hors ligne, un cache permet une
consultation autorisée, sans promettre un transfert complet ni à jour.

Pour les Chats liés à des projets autant que pour Architecte et Implémentation,
le lot de portée projet associe explicitement les contextes source et cible.
Un nom de projet ou une URL de dépôt identique ne prouve pas l'équivalence de deux
worktrees. Les politiques d'outils et la confiance restent locales à la destination.

## Ordre d'implémentation et preuves attendues

Les numéros historiques 1 à 5 sont conservés dans le
[plan de réalisation](macro-connect-implementation-plan.md). Le nouveau point 6
établit les mesures de référence et s'exécute en premier. Les points 7 et 8
isolent la reprise mobile et les budgets mémoire. Le point 9 précise la
télémétrie. Le consommateur desktop n'est pas un préalable aux corrections mobile.

Les budgets v2 actuels restent applicables jusqu'à une extension canonique
validée. Le contrat de transfert, ses migrations et ses tests constituent un
livrable préalable à l'annonce de cette capacité. La correction de ce document
ne rend aucun nouveau parcours disponible dans le produit.
