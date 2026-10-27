# Transfert de conversation entre PC

Conception révisée le 22 octobre 2026. Ce document corrige les réserves F1 et F2
de la proposition initiale. Il spécifie le comportement à réaliser ; les noms
d'états ci-dessous ne sont pas encore des opérations publiques du protocole.
Lire le [plan](macro-connect-implementation-plan.md) pour les lots et leurs preuves.

L'étape E de stockage cible reste interne et inactive. Son reçu de scellement
atteste uniquement les records, fragments, associations et mappings conservés
dans des tables dédiées. Il ne vaut ni admission du contexte, ni `target_ready`,
ni autorisation F. Une capture source brute native et une normalisation sémantique
interne permettent maintenant une chaîne synthétique vers ce stockage cible.
Le profil interne reconnaît des formes Codex et Macro AI, garde les originaux
admissibles récupérables et refuse les dépendances indispensables non prises en
charge. Les quatre couples passent par les vrais préparateurs et sérialiseurs,
avec nouvelle compaction et récupération d'un fait omis depuis la seule cible.
Les résumés restent des données historiques, y compris après une nouvelle
compaction. Les médias reconnus sont conservés dans le prochain corps ; les
attachments indispensables appartenant à un message assistant restent refusés.
Cette chaîne passe aussi par le contrat fermé
[portable-chat-history-1](../contracts/macro-pilot/v2/portable-chat-history/contract.md)
et sa validation autonome avant tout import natif. Son identité décrit le format ;
l'import vérifié au relais, sa configuration de support et l'admission F restent
à composer. Ces contrôles ne prouvent pas une borne mémoire du prochain
tour, dont la préparation actuelle matérialise encore l'historique. Aucune opération publique
de transfert ou activation de conversation n'en découle.

## Périmètre du premier transfert

Le mode Chat seul n'est pas un critère suffisant. Le précontrôle lit la portée
durable, les ressources référencées et l'état réel d'exécution sur la source.

| Cas source | Premier lot | Traitement avant réservation |
| --- | --- | --- |
| Chat sans projet, groupe ou tâche, inactif | Admis si son contexte est portable | Vérifier historique, compaction, références et assets nécessaires. |
| Chat lié à un projet ou groupe | Refusé dans ce lot ; conservé au point 5 | Présenter le contexte non pris en charge. Garder tous les rattachements source. |
| Architecte ou Implémentation | Refusé dans ce lot ; conservé au point 5 | Exiger ultérieurement association projet, plan, tâche et préconditions Git. |
| Génération ou outil en cours, effet inconnu | Refusé | Proposer de terminer ou d'arrêter sur la source, puis refaire le précontrôle. Un arrêt demandé ne prouve pas la fin de l'effet. |
| Question, approbation ou instruction en attente | Refusé | Résoudre, annuler explicitement ou vider la file sur la source. Ne rejouer aucune intention sur la cible. |
| Dépendance obligatoire indisponible ou non exportable | Refusé | Identifier la catégorie manquante sans exposer un contenu interdit. Aucune omission silencieuse. |
| Source hors ligne | Refusé | La consultation d'un cache ne prouve pas un état exportable courant. |

Les dépendances incluent les citations, références à d'autres conversations,
fichiers, images et éléments de contexte condensé. Une référence ne devient pas
un accès à un chemin arbitraire de la cible. Une dépendance facultative peut être
omise seulement si cette perte est annoncée et validée avant la réservation.
Le paquet utilise une liste de champs autorisés, jamais un export brut des objets
DB. Les règles de confidentialité existantes s'appliquent avant sa construction.

Le premier transfert rend la destination prête à recevoir le prochain message.
Il ne relance pas automatiquement une génération, une question, une approbation
ou un outil. Les sessions et credentials fournisseur restent locaux. La
normalisation de l'historique est validée pour chaque adaptateur accepté.

## Autorités et identités

Le relais est l'autorité durable pour la décision terminale `committed` ou
`aborted`. Les transactions SQLite de chaque PC restent locales. La source est
responsable du gel de sa conversation ; la cible de l'import inactif et de sa
préservation jusqu'à décision. La coordination bloque pendant une partition où
la décision reste inconnue. Elle ne promet pas une transaction distribuée atomique.

La clé d'exclusivité est l'incarnation du compte, l'instance source et la
conversation locale source. Il ne peut y avoir qu'une réservation active pour
cette clé, indépendamment du nombre de clients, de destinations ou d'identifiants
de transfert. Une cession confirmée ferme définitivement l'ancienne source à la
poursuite du travail ; un retour passe par un transfert de la conversation cible.

La source réserve dans une transaction native un identifiant de transfert, une
époque monotone et une cible unique. Elle refuse une seconde réservation tant
qu'une décision terminale n'a pas été réconciliée. Le relais réserve la même clé
par une contrainte durable d'unicité. Le record fixe aussi l'acteur initiateur
authentifié et les générations source et cible. La transition `sealed` lie une
seule fois la version du paquet, la révision scellée et l'empreinte du manifeste ;
`target_ready` ajoute son reçu sans remplacer ces valeurs. Une répétition retourne
le même reçu ; un changement de corps avec la même clé produit un conflit.

La correspondance retenue pour le contrat à construire réutilise `supervise`
et `respond` de l'initiateur sur chacune des deux instances du même compte.
La lecture seule ne permet donc ni le gel source ni l'import ou l'activation.
Une cession ne donne aucun accord d'outil ni droit de revue supplémentaire.
Les routes et l'encodage de ces exigences seront fixés dans l'extension canonique
du point 3. Le relais dérive l'acteur du bearer et recontrôle ses droits avant
chaque transition non terminale, avant confirmation et avant émission de contenu.
Il vérifie aussi les générations et la validité des reçus. Les preuves des
producteurs attestent leurs propres préparations ; elles ne remplacent jamais
les droits de l'initiateur. Une nouvelle session exige une réconciliation et une
réautorisation explicites, jamais un simple remplacement de l'acteur enregistré.
Si une génération producteur change avant confirmation, le transfert est abandonné
de façon durable avant toute nouvelle réservation. Une décision déjà confirmée
reste terminale ; sa récupération utilise une autorité courante sur l'instance.

## Transitions durables

Les états du relais portent des métadonnées uniquement. Les noms sont internes
à cette conception. Chaque transition vérifie l'état et la révision attendus et
conserve un reçu idempotent dans la même transaction que son écriture.

| État | Condition d'entrée | Sorties autorisées |
| --- | --- | --- |
| `reserved` | Réservation native source confirmée, gel installé, acteur autorisé et clé source libre dans le relais | `sealed` ou `aborted` |
| `sealed` | Aucun effet en vol, révision source cohérente, manifeste fixé et attestation source courante | `target_ready` ou `aborted` |
| `target_ready` | Import cible inactif durable, intégrité et contexte vérifiés, reçu cible courant | `committed` ou `aborted` |
| `committed` | Transition atomique réussie avec droits courants, preuve de gel source et reçu cible maintenus | Terminal ; répéter le même reçu est permis |
| `aborted` | Annulation ou abandon atomique avant confirmation | Terminal ; répéter le même reçu est permis |

Confirmation et annulation utilisent le même record et le même contrôle de
révision dans le relais. Une lecture "non confirmé" ne permet pas de libérer
la source. Seul un reçu durable `aborted` pour l'époque attendue le permet.
Un perdant de la course relit l'état terminal et applique sa décision ; il ne
crée pas une seconde décision. Après `committed`, une demande d'annulation
retourne la cession confirmée sans reprendre la source.

L'import cible reste épinglé après son reçu `target_ready`, même si un délai
local expire. L'épuisement de disque ou l'annulation passent par `aborted` avant
de supprimer une préparation prête. Un timeout réseau ne libère pas cette
réservation. Après `committed`, la cible active une seule fois sa conversation
dans une transaction native et conserve le reçu de cette activation.
Un ACK perdu ne crée ni second import ni second envoi fournisseur.

Une révocation avant confirmation rend toute confirmation impossible. Le relais
peut enregistrer un abandon de maintenance après ses propres contrôles, sans
accorder de droit utilisateur. La source doit encore récupérer sa preuve terminale
avant de se libérer. Après confirmation, la révocation supprime l'accès distant
mais ne prétend pas effacer une copie locale déjà importée. L'accès au statut de
récupération reste limité à l'autorité valide sur l'instance concernée.

## Gel et récupération locale

La réservation native précède toute émission du paquet. Elle ferme l'admission
des écritures de contenu, des envois, des reprises automatiques, des sous-agents
et des effets d'outils pour cette conversation. Tous les chemins, locaux et
distants, vérifient cette réservation ; les `Map` et `Symbol` de Pilot ne sont
pas une preuve durable. Une barrière ne peut être scellée tant qu'un effet déjà
admis est encore en vol ou que son résultat est inconnu.

Le précontrôle ne dispense pas de ce contrôle lors de la réservation : une
question, un envoi ou une modification peut apparaître entre ces deux moments.
Un échec à ce second contrôle annule la réservation avant émission. Les contrôles
de cohérence des captures sont conservés jusqu'au scellement.

Au redémarrage, les journaux locaux rétablissent le gel avant toute reprise.
Une source qui a réservé mais n'a pas reçu l'ACK du relais doit réconcilier la
réservation. Si elle n'existe pas, le relais doit pouvoir enregistrer un abandon
durable pour cet identifiant et cette époque avant dégel, et rejeter une arrivée
tardive de la réservation. Une réponse `not_found` isolée ne suffit donc pas.

Les reçus terminaux, l'époque et le fait qu'une source a été cédée survivent
à l'expiration des blocs. La purge peut compacter les détails, mais garde une
preuve qui interdit de réutiliser une époque ou de rouvrir un transfert terminal.
La restauration d'une sauvegarde doit réconcilier cette autorité avant de réactiver
une conversation source. La restauration officielle détache aujourd'hui les
identités Pilot, comme le décrit la [sauvegarde de profil](local-profile-backup.md).
Retrouver l'ancienne instance dans l'état d'authentification restauré ne suffit
donc pas. Le traitement suivant fait partie du lot F et précède son activation.

Chaque conversation transférable reçoit une filiation non secrète séparée des
credentials : origine du relais, incarnation du compte, instance source et
identité locale de la conversation. Cette filiation suit les sauvegardes et la
copie source cédée, sans restaurer bearer, session, clé d'instance ni accord
d'outil. Sa valeur aide à retrouver la décision ; elle n'accorde aucune autorité.
La table de cession conserve le lien vers cette origine à travers une nouvelle
association d'appareil. Une nouvelle instance ne remplace pas l'ancienne dans
la clé d'exclusivité.

À chaque restauration officielle, y compris d'une archive antérieure à cette
filiation, le backend installe une barrière durable sur les conversations
restaurées avant toute admission ou reprise. La lecture de l'historique reste
possible. Files, outils, sous-agents et envois ne repartent pas sur l'identité
restaurée tant que la propriété n'a pas été réconciliée avec une autorité valide
sur le compte d'origine. La déconnexion ou une nouvelle connexion ne lève pas
cette barrière. Un relais inaccessible laisse les conversations concernées
en lecture seule ; un `not_found` sous une nouvelle instance n'est pas une preuve.

Si une archive ancienne ne permet pas de reconstruire une filiation vérifiable,
la reprise de l'ancienne conversation est refusée. L'utilisateur peut créer
explicitement une nouvelle conversation à partir du contexte portable autorisé,
avec de nouveaux identifiants, sans file, interaction ni effet actif hérité.
Cette copie est présentée comme une nouvelle branche de travail et ne prétend
pas reprendre la propriété de l'ancienne source. Elle n'est jamais automatique.
Le lot doit tester ce chemin et la conservation des secrets détachés ; il ne
prétend pas empêcher un clonage volontaire exécuté hors protocole.

Une cible qui a perdu ses données après confirmation reste en erreur de
récupération. Elle ne provoque pas un dégel implicite de la source. Une remise
en état ou une nouvelle cession explicite doit résoudre cette situation.

## Données et limites

Le relais conserve références, époques, acteurs, révisions, empreintes, états et
reçus. Aucun transcript, titre, nom de fichier, pièce jointe ni corps fournisseur
n'entre dans sa base, ses journaux ou les erreurs. Le contenu transite dans des
buffers bornés et expirables. Les blocs vérifiés restent sur les deux PC et la
reprise utilise leur empreinte et leur offset. Le téléphone peut initier la cession
sans télécharger puis réémettre tout l'historique.

Le contrat du point 3 fixe avant émission l'admission des blocs, des traitements,
des assets, de leur taille décompressée, de la préparation sur disque et des
réservations simultanées. Ces limites de ressources ne deviennent pas un plafond
arbitraire du nombre de messages ou de la longueur totale de l'historique.
L'objectif est l'historique complet récupérable, même après compaction ; un contexte
indispensable manquant impose un refus. Codex et Macro AI sont prioritaires pour
la preuve du contexte fonctionnel normalisé, sans reprise de session identique.
Les garde-fous v2 existants ne sont pas augmentés par défaut. L'import valide au
fil de l'eau, refuse les traversées de chemin et remappe les identifiants sans
transformer des traces historiques en outils actifs ou en instructions fiables.

Le premier transfert ne reprend pas le checkpoint de compaction de la source.
La cible publie les messages originaux sans état de compaction ni
`provider_input_items` enregistrés ; les résumés restent consultables dans
l'archive comme données historiques. Le message suivant passe par le chemin
d'envoi ordinaire, qui reconstruit les éléments fournisseur depuis le contenu.
Si l'historique tient dans la fenêtre du modèle cible, il part en entier ;
sinon, la cible compacte de nouveau avant le tour utilisateur, au prix d'un
appel modèle et d'un résumé différent de celui de la source. Le scénario natif
synthétique vérifie que ce prochain corps est identique à celui que la source
aurait envoyé, pour Macro AI, Codex, une conversation compactée et des
ressources. La restauration du checkpoint sera réexaminée avec la règle de choix
du modèle cible : un checkpoint calculé pour le modèle source n'est pas
forcément valide pour la cible.

## Preuves nécessaires avant activation

| Scénario | Résultat exigé |
| --- | --- |
| Deux clients, deux transferts, même source | Un seul record peut progresser ; aucun second import activable. |
| Confirmation contre annulation | Une seule transition terminale ; le perdant applique le reçu gagnant. |
| ACK de réservation perdu ou requête retardée | Aucun dégel sur `not_found` seul ; abandon durable ou reprise de la réservation courante. |
| Session révoquée avant confirmation | Aucune cession sous les droits d'un producteur de remplacement. |
| Expiration locale après `target_ready` | Préparation conservée jusqu'à décision ; aucun reçu de préparation visant des données volontairement purgées. |
| Crash de chaque acteur à chaque transition | Gel rétabli et décision réconciliée avant reprise. |
| Ancien ACK, ancien bloc, ancienne génération | Rejet ou même reçu terminal ; aucun nouveau transfert ni nouvel effet. |
| Chat lié à un projet ou file apparue tardivement | Refus avant scellement ; source et files préservées. |
| Import tronqué, disque plein, asset obligatoire absent | Cible inactive ; abandon réconciliable ; pas de dégradation silencieuse. |
| Sauvegarde antérieure à une cession, identité Pilot détachée puis nouvelle association | Barrière installée avant toute admission ; filiation vérifiée, décision d'origine retrouvée, source cédée non réactivée. |
| Archive ancienne sans filiation ou relais inaccessible | Historique consultable, aucune reprise ni effet automatique ; copie de contexte uniquement par action explicite avec nouveaux IDs. |

Ces cas valident la coordination et l'admission. Ils ne prouvent pas une
exécution exactement une fois d'un effet externe arbitraire.
