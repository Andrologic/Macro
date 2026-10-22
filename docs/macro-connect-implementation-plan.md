# Plan de réalisation de Macro Connect

Révision du 22 octobre 2026, après correction des réserves F1 à F3 de la relecture.
Ce plan prépare le lancement ; aucun lot produit n'est implémenté par cette
révision documentaire. La version de livraison reste à définir. Le manifeste
desktop 0.1.8 n'est pas une preuve de publication de ces fonctions.

Lire l'[architecture](macro-connect-peer-architecture.md) pour les responsabilités
et la [conception du transfert](macro-connect-transfer-design.md) avant les points
3, 4 et 5. Les contrats v1 et v2 actuels restent en vigueur jusqu'à l'intégration
d'une extension canonique vérifiée.

## Périmètre retenu et dépendances

Les numéros 1 à 5 sont ceux de la proposition initiale. Les nouveaux points ont
les numéros 6 à 9. L'ordre des lignes est l'ordre recommandé de réalisation,
pas une renumérotation. Les points 7, 8 et 9 rendent explicites des travaux
auparavant regroupés sous le point 2, désormais consacré aux lectures desktop.

| N° | Travail | Description | Maintenant ? / Horizon | Difficulté · Profil conseillé | Dépend de | Lot proposé |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | Mesures de référence | Comparer les phases, volumes, lectures natives et mémoire avant changement ; fixer budgets et objectifs vérifiables. | En premier, chantier actuel ; prérequis F3 | Élevée, mesures entre trois runtimes · Sol 6.1 / high | Aucun | A, mesures |
| 7 | Reprise mobile | Séparer transport, fraîcheur et autorité ; reprendre sans effacer inutilement les données encore consultables. | Maintenant, après les mesures concernées | Élevée, concurrence et révocation · Sol 6.1 / high | 6 | B, continuité mobile |
| 2 | Lectures desktop | Réduire les observations, borner avant IPC et lire les seules sources utiles ; coalescer les états remplaçables. | Maintenant, après les mesures concernées | Élevée, SQLite et cohérence des captures · Sol 6.1 / high | 6 | C, sources desktop |
| 8 | Mémoire cumulée | Admettre et évincer pages, images et ressources à l'échelle du processus, en préservant la lecture active et les intentions incertaines. | Maintenant, après fixation des budgets | Élevée, ressources partagées et copies transitoires · Sol 6.1 / high | 6, puis 7 dans le même lot | B, continuité mobile |
| 9 | Télémétrie utile | Adapter la collecte et le rafraîchissement CPU/RAM aux abonnés visibles et aux données réellement demandées. | Chantier actuel, avec les lectures desktop | Moyenne, cycle de vie et fraîcheur · Sol 6.1 / medium | 6 | C, sources desktop |
| 1 | Desktop client de plusieurs PC | Ajouter un consommateur par cible tout en gardant le producteur et le contexte local actifs. | Chantier actuel ; ne bloque pas les premières corrections mobile | Élevée, routage par instance et générations · Sol 6.1 / high | 6 | D, consommateur desktop |
| 3 | Import inactif d'un Chat sans projet | Définir le contrat, vérifier la portabilité, capturer et importer l'historique sans exécution ni annonce prématurée de transfert. | Chantier actuel, avant cession | Élevée, format canonique et contexte fournisseur · Sol 6.1 / high | 6, 2 | E, import portable |
| 4 | Cession exclusive entre PC | Réservation native, décision atomique relais, import épinglé et récupération après panne ; aucun double propriétaire actif. | Chantier actuel, après import et client desktop | Très élevée, coordination entre bases et effets · Astra / low ; réalisation relais Sol 6.1 / high | 1, 3 | F, cession |
| 5 | Conversations avec portée projet | Étendre d'abord aux Chats liés à des projets, puis à Architecte et Implémentation avec contexte, plans, tâches et Git. | Séquence ultérieure du chantier actuel, après cession globale vérifiée | Très élevée, équivalence de contextes et sécurité des outils · Astra / low puis Sol 6.1 / high | 4 | G, portée projet |

Ces profils sont des recommandations, pas des autorisations de lancement.
Les identifiants disponibles sont `gpt-6.1-sol`, `gpt-6-astra` et `gpt-6-luna`.
Luna peut faire de la découverte ciblée, sans code ni audit. Les règles d'accord
de l'utilisateur s'appliquent avant toute délégation Sol ou Astra ; un accord
pour un autre chantier ne suffit pas. La préparation présente ne lance aucun agent.

## A. Mesurer avant de modifier le comportement

Le point 6 produit un format de métriques commun, des fixtures synthétiques
reproductibles et des résultats liés aux SHA exacts des trois dépôts. Le desktop
possède la définition du format partagé ; les autres dépôts importent la version
retenue sans créer de variante. Les artefacts locaux détaillés restent hors des
dépôts publics. Les fixtures et scripts réutilisables peuvent être suivis.

| Parcours | Mesures minimales |
| --- | --- |
| Repos et écran masqué | Requêtes et attentes vivantes, réveils, lectures DB, octets et allocations conservées. |
| Ouverture froide et retour au chat | Temps jusqu'au dernier message affiché, lecture DB, construction de capture, transport et application UI. |
| Conversation visible ou autre chat modifié | Sources relues, états reconstruits, octets utiles contre enveloppes, événements terminaux conservés. |
| Retour du premier plan, coupure et reconnexion | Phase de connexion, négociation, réconciliation, durée d'indisponibilité et resets de curseur. |
| Historique long et pagination | Octets avant décodage, messages retenus, copies JSON, position de lecture et lectures natives. |
| Plusieurs PC, dont un lent | Budgets cumulés, équité des requêtes, isolation des échecs et nombre de souscriptions par cible. |

Les profils distinguent loopback, RTT simulée et interruptions déterministes.
Les résultats précisent préparation exclue ou incluse, échantillons, dispersion,
état froid ou chaud et taille des données. Les compteurs consommateurs et
producteurs sont séparés. Les octets HTTP compressés, décompressés et le contenu
utile ne sont pas confondus. Les phases native et desktop doivent utiliser leurs
vraies lectures SQLite sur une base synthétique pour chiffrer leur coût.

Le RSS natif, le heap mesuré et une estimation d'octets sérialisés sont des
mesures différentes. Une mesure inaccessible sur une plateforme est marquée
"non mesurée", avec son protocole de recette, sans être remplacée par un chiffre
de fixture. Le téléphone physique reste une validation ultérieure identifiée.

Critère de fin du point 6 : protocole de mesure reproductible, référence par
parcours et budgets numériques fixés pour les ressources à optimiser. Les seuils
de non-régression sont écrits avant le premier changement correspondant. Une
limite existante n'est pas augmentée pour rendre le benchmark vert. Un coût
encore non mesuré interdit d'annoncer un gain sur ce coût, sans bloquer les autres
corrections prouvées.

## B. Continuité et mémoire mobile

Le point 7 conserve un seul flux partagé par cible. Un échec transport ne devient
pas une révocation. Le cache RAM consultable respecte les bornes d'autorité et
de capture de l'architecture ; aucune persistance de transcript n'est ajoutée.
Les actions attendent les droits et la continuité revalidés. Un trou de journal
recharge la ressource affectée, sans reset de toutes les machines.

Le point 8 ajoute un budget cumulatif du processus et un comptage des objets
partagés pour éviter de facturer deux fois un feed commun. Le comptage couvre
pages, captures, fichiers, réflexions, images décodées et allocations transitoires
identifiées. L'éviction retire d'abord les données inactives ; elle préserve la
position de lecture, le brouillon et les intentions en attente de réconciliation.
La mémoire ne se borne pas en supprimant le reçu d'une écriture incertaine.

Critères de fin : tests coupure/reprise et premier plan, expiration, révocation,
changement de compte et réponse tardive ; aucun second envoi après ACK perdu ;
budgets cumulés tenus pour plusieurs instances ; absence de réadmission après
purge ; gains comparés au point 6 avec les mêmes fixtures. Le plafond actuel
par contrôleur reste un garde-fou jusqu'à remplacement explicitement validé.

## C. Sources desktop et télémétrie

Le point 2 commence par l'admission native avant chargement d'un transcript et
sa sérialisation IPC. Une limite ne doit pas transformer tout long historique
valide en conversation inutilisable : les fenêtres bornées et la révision de
contenu doivent permettre sa lecture progressive. Les contrôles de provenance
et les textes retenus restent ceux de la politique d'export négociée.

Les notifications après mutation et les changements d'activité pilotent les
invalidations. Les chemins natifs et les reprises sont couverts, avec une
revalidation de secours. La double observation actuelle ne disparaît qu'après
preuve d'une garantie de cohérence équivalente. La coalescence ne remplace que
les états intermédiaires ; elle conserve l'ordre des erreurs, interactions et fins.

Le point 9 arrête la collecte inutile sans cacher une indisponibilité par zéro.
Ses abonnements et sa fréquence suivent la visibilité et la demande agrégées,
avec nettoyage au démontage, à la suspension et à la perte d'autorité.

Critères de fin : moins de lectures DB et de sérialisations sur les parcours
mesurés ; aucune capture mélangeant deux révisions ; invalidation après écriture
native ou externe ; refus avant allocation excessive ; cache et télémétrie
nettoyés ; erreurs et événements terminaux conservés.

## D. Consommateur desktop

Le point 1 crée un transport consommateur typé, séparé des livraisons producteur.
Les requêtes sont rattachées au profil, à l'origine, au compte, à la session et à
l'instance cible. Le service global local reste local. Une clé d'instance locale
ne devient jamais une preuve pour une autre instance.

Critères de fin : deux cibles consultées simultanément pendant que le producteur
local continue ; panne, changement de génération et révocation isolés par cible ;
aucune confusion d'identifiants entre deux conversations de même ID ; capacités
annoncées conformes à la plateforme. Le refus actuel de certains contenus v2
sur une plateforme ne disparaît pas par simple réutilisation d'un client.

## E. Contrat et import inactif

Une étape partielle ajoute un noyau SQLite cible distinct des conversations
ordinaires : réception segmentée, journal idempotent, mapping durable et
scellement du stockage. Sa composition normale refuse toute opération ; seule
une autorité native de test permet les preuves synthétiques. Le budget du banc
de preuve ne définit aucun plafond de production. Un domaine persistant commun
couvre les octets de préparation E et le staging des attachments, sans plafonner
rétroactivement les assets ordinaires. Les seuils propres aux attachments restent
inchangés. Le protocole de mesure 6 distingue le schéma 15 des historiques 3/4/5.

Ce noyau ne constitue ni un importeur de Chat ni une admission de contexte.
La capture source atomique, son index de dépendances, la normalisation réelle,
le contrat portable normatif et les barrières F restent à réaliser. La
récupération complète sur disque est distincte de la préparation du prochain
tour, qui matérialise actuellement le contexte en O(N). Aucune route publique,
capacité de transfert, promotion ou activation n'est ajoutée par cette étape.

Le point 3 possède le contrat canonique de transfert dans le dépôt desktop.
Il fixe les opérations, droits, champs, états, plafonds, erreurs et fixtures,
puis les validateurs générés et leurs imports exacts dans le relais et le mobile.
La liste fermée couvre les variantes de portée ; le premier paquet n'autorise
que le Chat sans projet décrit dans la conception du transfert.

Les migrations de journal sont versionnées et la cible importe atomiquement
dans un état inactif, avec remappage des identifiants et origine conservée. Le
précontrôle des dépendances est rejoué à l'admission puis au scellement. Les
images et assets obligatoires sont contrôlés par taille et empreinte. La
compaction et les données fournisseur ne sont pas reprises par un spread DB.

L'objectif est l'historique complet récupérable, y compris après compaction.
Un contexte indispensable absent ou non exportable entraîne un refus explicite.
Le nombre total de messages et la taille d'un texte ne sont pas limités par les
seuils d'affichage : lecture segmentée, traitement incrémental et préparation sur
disque sont admis selon des ressources justifiées. Codex et Macro AI sont les
premiers adaptateurs dont le contexte fonctionnel doit être prouvé, sans promettre
une reprise de session fournisseur identique ni appeler un fournisseur à l'import.

Critères de fin : compatibilité v1 inchangée ; import idempotent et inactif ;
contexte non portable refusé avant gel ; données tronquées, privées ou invalides
refusées ; aucun fournisseur appelé. Les tests injectent les opérations de
préparation. Le producteur normal les garde désactivées jusqu'à validation des
barrières du point 4 ; une capacité de test n'est pas une annonce produit.

## F. Décision et cession

Le point 4 suit la machine à états de la conception du transfert. Il ajoute la
réservation durable native et la contrainte d'unicité source dans le relais.
L'activation exige le reçu terminal confirmé. Confirmation et annulation sont
des transitions concurrentes du même record, jamais une lecture suivie d'une
libération non conditionnelle. Les reçus et époques survivent à la purge des blocs.

Le lot inventorie et couvre tous les points d'admission : envoi local ou distant,
instructions en file, reprise après crash, sous-agent, outil et écritures issues
d'un effet déjà admis. Il prévoit le statut de récupération consultable par un
producteur encore autorisé même si l'initiateur a perdu ses droits. Ce statut
minimal ne rend pas de transcript et n'accorde pas de nouveau droit de cession.

Le chemin officiel de sauvegarde/restauration fait partie de ce lot. Il conserve
une filiation non secrète distincte de l'identité Pilot détachée et installe une
barrière durable sur les conversations restaurées avant toute admission. Les
archives anciennes sans filiation et le relais inaccessible gardent l'historique
consultable sans reprise automatique. Une copie explicite vers de nouveaux IDs
reste distincte d'une reprise de propriété. Cette barrière ne restaure aucun secret.

Critère de fin : tous les scénarios de concurrence et de panne de la conception
passent avec le relais et les deux journaux SQLite réels sur des données
synthétiques. Chaque arrêt est injecté avant et après chaque commit durable.
Le test de restauration inclut une archive créée avant cession, une archive sans
filiation, le détachement des credentials, une nouvelle association et un retour
tardif de l'ancienne réservation. Aucun de ces chemins ne doit admettre un effet
avant réconciliation ou création explicite d'une nouvelle copie indépendante.
Aucune preuve d'exécution exactement une fois d'un fournisseur n'est déduite
d'un simple ACK de transport. Une revue indépendante de ce lot est exigée avant
intégration et annonce de capacité.

## G. Portée projet

Le point 5 réutilise les mêmes droits et barrières. L'utilisateur associe les
projets source et cible ; le système vérifie portée durable, contexte des groupes,
mode d'exécution, branche, révision et modifications nécessaires. Une association
de nom ou d'URL de dépôt seule ne suffit pas. Les outils et la confiance sont
recalculés à destination.

Critères de fin : Chat lié à un projet et Chat de groupe couverts avant d'annoncer
cette variante ; cas Architecte et Implémentation annoncés séparément ; plans,
tâches et worktrees incohérents refusés avant effet ; aucune sélection globale
utilisée comme contexte de repli.

## Organisation et intégration

Chaque lot possède un worktree `feature/*` par dépôt modifié. Les checkouts
principaux restent sur `develop`. Un auteur est responsable de chaque worktree ;
les auteurs de dépôts différents n'éditent pas une seconde copie du contrat.
Les profils de revue conseillés sont Sol 6.1 / high pour les lots A à E et G,
et Astra / low pour la coordination F, avec un auditeur distinct de l'auteur.
Leur lancement reste soumis aux autorisations applicables.

Après A, B et C peuvent avancer en parallèle. D peut démarrer après A, avec une
propriété explicite du client natif pour éviter un conflit d'édition avec C.
E suit C pour s'appuyer sur les captures natives bornées. F attend D et E ; G
attend F. Un contrat modifié est relu et importé par exact SHA et blob avant les
adaptations dépendantes. Les résultats d'audit et de recette sont conservés à
chaque intégration locale, avec un commit vérifié par étape.

Les outils nécessaires à la recette sont préparés dans les worktrees et les
profils de test documentés. Une dépendance manquante, un SDK non accessible ou
une permission d'écoute loopback est une limite d'environnement à résoudre,
pas une raison de supprimer une assertion ou de simuler un test réussi.

Exclusions conservées : aucune réplication générale des bases entre PC, aucun
historique durable sur le relais, aucun transfert de secrets ou d'accords outils,
aucune réécriture de stack inspirée de T3 Code. Une route directe, un nouveau
tunnel, un cache persistant de chats et un changement de transport généralisé
restent hors de ce chantier. Aucun push, déploiement, installation ou APK n'est
autorisé par la seule validation de ce plan.

## Fermeture des réserves de conception

| Réserve | Correction documentaire | Preuve encore exigée dans le produit |
| --- | --- | --- |
| F1 | Autorité relais, exclusivité par source et époque, transitions atomiques, gel durable et récupération explicités dans la conception du transfert. | Points 3 et 4, notamment deux cessions concurrentes et annulation contre confirmation. |
| F2 | Premier transfert explicitement sans projet ; refus précoce des autres portées ; Chats liés aux projets inclus au point 5. | Précontrôle et seconde validation au scellement ; tests du contexte Chat projet et groupe. |
| F3 | Point 6 obligatoire avant optimisation ; lots mobile et desktop découplés du nouveau consommateur PC. | Références reproductibles et objectifs fixés avant les changements. |

Le lancement peut commencer par A sans attendre la réalisation du transfert.
La fermeture de ces réserves dans les documents ne constitue pas une validation
du protocole futur, de ses migrations ou de ses garanties d'exécution.
