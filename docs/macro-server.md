# Le serveur Macro

Proposition pour la section 3.10 de `docs/agentic-systems.md`. Les étapes C à H désignent le plan de ce document. Les opérations proposées ci-dessous devront être ajoutées au contrat Macro Connect.

## Une machine dans Macro Connect

Le serveur Macro est un processus Rust qui démarre avec la machine et continue de tourner une fois les applications desktop fermées. Il possède ses propres données et annonce ses capacités dans le catalogue Connect. Dans « Où », Operate propose cet ordinateur, les autres ordinateurs et les serveurs associés. Une machine hors ligne reste identifiable avec son dernier état connu.

| Sur le serveur | Dans l'application desktop |
| --- | --- |
| Hôte Argentic, adaptateurs de harnais, programmes MCP, base SQLite, archives et dossiers d'exécution | Architect, bibliothèque d'origine, édition des brouillons, import et export |
| Planificateur, précontrôle de lancement, contrôle des permissions et résolution des secrets dans le coffre | Fenêtre de lancement, choix de la machine, saisie des secrets et présentation du consentement |
| Producteur Connect, journal d'événements, lectures et commandes propres aux exécutions locales | Operate, graphe, threads, réponses, approbations, téléchargements et notifications |
| CLI d'administration locale pour l'association, le coffre, le diagnostic et la maintenance | Gestion des accès Connect et suivi des machines |

Le desktop reste producteur pour ses propres exécutions et devient client des autres machines depuis Operate. Les deux modes appellent les mêmes services Rust pour admettre une exécution, répondre à un agent et programmer une échéance. Les adaptateurs Tauri et Connect apportent chacun leur contexte d'autorisation et traduisent les événements du service.

## Installation et exploitation

Distribuer un binaire de service `macro-server` et une CLI locale, dans le même binaire si possible. Extraire les services nécessaires du backend de Macro dans une cible Rust compilable sans Tauri, WebView ni ressources frontend. Aujourd'hui, `src-tauri/Cargo.toml` lie la bibliothèque à Tauri et `src-tauri/src/lib.rs` initialise `HostState`, la base, la récupération des exécutions et les intégrations desktop. Le démarrage du service doit initialiser ses dépendances explicitement et injecter un émetteur d'événements indépendant de l'interface.

Pour la première version, fournir des artefacts vérifiables par système et architecture qualifiés, une unité système `systemd` sous Linux et un `LaunchDaemon` sous macOS. Installer le processus sous un compte dédié sans privilèges, avec un répertoire de données persistant privé. Valider le démarrage après redémarrage avant ouverture d'une session graphique. Borner les redémarrages automatiques et prévoir l'arrêt propre des sous-processus. Un verrou par répertoire empêche deux démons d'ouvrir le même état. Le diagnostic local indique état SQLite, coffre, association Connect et profils de harnais utilisables.

L'administrateur installe les harnais et programmes requis sous ce compte ou dans un emplacement administré. La CLI valide la configuration avant d'activer les lancements. Le démon ouvre une connexion sortante vers le relais Connect. L'administration locale passe par la CLI et, si le service doit être joint, par un socket Unix protégé. Les routes HTTP de workspace du prototype `macro-headless` restent hors du service.

L'hébergement fourni par Macro déploiera le même binaire et le même protocole. Une instance isolée par client, un stockage persistant et un coffre propre à cette instance suffisent comme modèle de départ. Le service d'hébergement ajoutera provisionnement, sauvegardes, quotas et supervision. Il devra formaliser qui peut administrer la machine et accéder à ses données.

## Association, droits et coffre

Réutiliser l'association au compte Connect. La CLI lance une tentative et affiche une URL à ouvrir sur un appareil de confiance. Le démon conserve le secret de réclamation et enregistre sa propre session d'appareil et sa propre clé d'instance. Ajouter une confirmation de l'identité de la machine, qui lie aussi sa clé publique de chiffrement à l'association.

Donner un moyen de voir, révoquer et renouveler ces droits depuis le compte. Le nom de machine sert à l'affichage. La session authentifiée identifie le demandeur et la clé d'instance authentifie le producteur. Le serveur vérifie les droits sur la cible et sur la ressource au moment de l'effet. L'annonce d'une capacité sert à l'interface.

| Opération | Autorité à vérifier |
| --- | --- |
| Lister, lire le journal ou les threads | Droit de lecture sur l'instance et accès à l'exécution |
| Répondre, envoyer un message, reprendre un agent | Droit de réponse, interaction ou état attendu |
| Approuver une action d'agent | Droit spécifique d'approbation, décision liée à la demande et à son échéance |
| Envoyer une version, lancer, créer ou modifier une programmation | Droits d'envoi et de lancement sur la cible, accord sur le plan calculé par celle-ci |
| Modifier les secrets MCP | Droit d'écriture distinct sur le coffre du blueprint, réponse limitée à la présence de la référence |
| Interrompre, arrêter, supprimer, télécharger | Droit explicite pour le geste et contrôle de l'état de l'exécution |

Les noms précis et la correspondance avec `supervise`, `respond` et `approve_tools` relèvent du contrat canonique. Le serveur rattache l'acteur à la preuve fournie par Connect. Il vérifie l'identité de la cible, la génération de l'accès et la révision de la ressource. Une révocation invalide les lectures et commandes de la session, y compris les transferts en cours. Les relectures de reçus exigent aussi un accès valide.

Utiliser TLS vers le relais. Pour les secrets transmis depuis le desktop, prévoir un canal chiffré de bout en bout vers la clé de la machine associée. Les enveloppes authentifiées lient le secret à la cible, à son destinataire logique et à la préparation de lancement. L'intégrité SHA-256 de l'archive sert à vérifier les octets. L'identité et l'autorisation viennent de Connect. Le relais transporte les données demandées avec des limites de taille et de durée et conserve les seules métadonnées nécessaires au routage et aux reçus.

Séparer les espaces du coffre pour Connect, les identifiants fournisseurs et les secrets MCP. Pour MCP, indexer par identité de blueprint reconnue par la cible, serveur MCP et nom déclaré. Les références restent valides d'une version à l'autre et permettent la rotation. L'identité du blueprint inclut son origine approuvée, pour qu'un identifiant issu d'une archive importée ne donne aucun accès au coffre. Seul le processus MCP autorisé reçoit la valeur requise. SQLite enregistre les références et les générations, jamais les valeurs. Écarter les valeurs des journaux, archives, reçus, arguments de commande et événements. Qualifier un coffre accessible au compte de service après démarrage sans intervention. Le trousseau desktop implique aujourd'hui parfois un déverrouillage. Un magasin chiffré nécessiterait une clé fournie séparément par l'OS ou l'administrateur du service.

## Lancer sur le serveur

La fenêtre de lancement suit l'étape D. Le serveur fournit les modèles disponibles, les prérequis et les modes de dossier qu'il accepte. Il refuse un blueprint qui exige un dossier choisi. Operate explique ce blocage avant le lancement.

1. Le desktop envoie une référence d'origine et l'identité de la version, les octets de l'archive `.agsdl` et le fichier `macro-settings.json` de C. Il envoie aussi la demande de lancement versionnée avec le message de départ, le nom éventuel, les remplacements de modèles et les options. Les champs de H alimentent le message de départ JSON. L'archive conserve son format standard. La fiche de version reprend le nom, le numéro, la note et la date utiles à Operate. Le message et les paramètres propres à un lancement restent dans sa demande.
2. Le serveur reçoit les octets dans une zone temporaire privée et bornée. Il vérifie taille et SHA-256 de l'archive et des réglages, puis ouvre l'archive avec `open_archive_bytes`. Argentic vérifie l'inventaire et chaque membre. Le serveur valide la version du schéma Macro. Il garde séparément l'empreinte des octets de l'archive et le `source_sha256()` d'Argentic, utilisé pour l'identité de compilation. La paire archive et réglages est immuable après publication. Une réception interrompue reste provisoire.
3. Le serveur fait le précontrôle D à partir de ses capacités et du flow compilé. Il retourne un plan avec les modèles résolus, les programmes manquants, les permissions effectives et les secrets MCP nécessaires. La liste tient compte des agents accessibles, de leurs permissions et des appels directs, y compris dans les compositions. Les secrets déjà présents ne sont pas redemandés. Le desktop envoie les valeurs manquantes si l'utilisateur le décide. Chaque dépôt de secret a son propre reçu, lié à la préparation, et vérifie la génération attendue du secret pour éviter d'écraser une rotation concurrente. Le journal conserve les références et les identifiants d'opération. En cas de panne, la reprise distingue une valeur déjà enregistrée d'un envoi encore à faire.
4. Le desktop affiche le plan de la cible et lui transmet le consentement par une commande authentifiée. L'accord couvre l'identité du blueprint, la machine et les permissions effectives. La confirmation de lancement référence la préparation et l'empreinte du plan présenté. Un accord précédent peut être réutilisé pour une version aux permissions comprises dans l'accord existant, après contrôle par la cible. Un élargissement, un changement matériel de script ou de destination MCP, ou un changement de politique qui invalide l'accord impose une nouvelle décision.
5. Au lancement, la cible vérifie que la préparation, les droits, le consentement et les prérequis sont toujours valides. Elle crée le dossier de travail, appelle `retain` dans les données privées de l'hôte puis `bind_scope` sur le contexte de confiance. Elle conserve le contexte lié et la référence de copie retenue pour l'exécution. L'admission enregistre dans SQLite la version, la configuration utilisée sans valeurs secrètes, l'identité d'exécution et le reçu. Le moteur démarre sur cette base et applique la reprise prévue par Argentic.

Un identifiant de demande stable et une empreinte de la demande sans secrets lient les tentatives à l'acteur opérateur et à la machine. Une tentative identique retrouve son reçu ou son état en cours. Une réutilisation de l'identifiant avec des paramètres différents échoue. La clé de reprise survit à une reconnexion du même appareil. L'autorisation, elle, est vérifiée dans la session courante. L'enregistrement de l'admission, du reçu et de l'identité d'exécution doit être atomique côté cible. Si le serveur tombe après une admission, sa reprise réconcilie l'identité existante avec l'état du moteur avant toute relance. Un effet dont l'issue reste inconnue remonte dans Operate avec un état explicite. La cible nettoie les réceptions et copies abandonnées une fois leur bail expiré et leurs références vérifiées.

Les exécutions et programmations épinglent la copie vérifiée sur la cible. La première livraison doit aussi protéger la suppression côté bibliothèque d'origine. Réserver la version source avant l'envoi. Conserver cette référence tant qu'un reçu de la cible indique un usage ou que l'issue du lancement reste inconnue. Libérer la référence après confirmation de la cible que les usages ont disparu. Une machine injoignable maintient la référence. Le traitement d'une machine perdue définitivement reste à décider.

## Operate et demandes humaines

La machine d'exécution conserve l'état, les graphes, les threads, le journal et les fichiers. Operate combine les résumés locaux et distants avec leur emplacement. La clé de sélection inclut l'origine du relais, le compte, l'instance propriétaire et l'identifiant d'exécution. Les détails arrivent à l'ouverture du graphe ou du thread, par lectures bornées. Un flux par instance signale les changements. Une rupture de curseur recharge les éléments concernés. Une vue en cache indique sa fraîcheur et perd ses actions quand les droits expirent. Une révocation retire les données protégées.

Les questions, approbations et interruptions d'E apparaissent dans « À traiter ». Une demande est persistée avec son identifiant, sa révision et son échéance éventuelle. Tout desktop Connect qui possède le droit requis peut agir. Si deux appareils répondent, le serveur accepte la première réponse valide et indique l'état courant au second. Les nouvelles tentatives du premier renvoient le même reçu. Après fermeture du dernier desktop, les demandes restent sur le serveur jusqu'à résolution ou expiration selon le moteur. Reprendre un agent dépend du geste d'E. La pause d'une exécution et les délais d'approbation pendant cette pause suivent G.

Le serveur publie les événements d'attention et les clients appellent `notify.actionRequired` ou l'aide partagée adaptée. Le lien ouvre l'exécution et le thread sur la bonne machine. Dédupliquer l'affichage par événement sur chaque appareil, puis retirer la demande résolue sur tous les clients. Les motifs d'erreur, de fin et de programmation manquée restent consultables à la reconnexion. Au premier lot, un desktop connecté reçoit les notifications natives. Hors connexion, le journal sur la machine et la reprise dans « À traiter » assurent la continuité. Un canal push hors application demanderait un lot et une politique de contenu propres.

## Dossiers et isolement

Le serveur crée un seul dossier de travail par exécution, sous une racine gérée. Il choisit le chemin à partir de l'identité interne de l'exécution. Le dossier et la copie Argentic sont distincts. Les agents et les MCP locaux obtiennent le dossier de travail en écriture et les ressources retenues en lecture seule. Appliquer le profil de confinement aux sous-processus. Il doit limiter l'accès aux autres exécutions, au coffre, à la base, aux clés Connect et au reste de l'hôte. Lancer uniquement sur les combinaisons système et harnais où ce profil est vérifié. Les permissions de l'archive peuvent encore réduire le profil autorisé par la machine. Prévoir des plafonds configurables de concurrence, de stockage et de ressources.

Operate liste et télécharge les fichiers ordinaires sous la racine de l'exécution. Le serveur ouvre le fichier par des opérations ancrées dans cette racine, refuse les liens et sorties de racine et vérifie le type sur le descripteur ouvert. Le téléchargement s'appuie sur une capture cohérente bornée en taille, avec longueur et SHA-256. Une modification pendant la capture peut demander un nouveau téléchargement. Appliquer les droits et quotas à la liste et au flux. « Supprimer » suit E pour effacer l'exécution terminée et son dossier, avec nettoyage de la copie retenue après disparition de toutes les références. L'envoi de fichiers vers une exécution distante reste différé.

## Programmations

F fournit le planificateur commun. Sur le serveur, il tourne dans le processus de service et stocke la programmation dans SQLite. Il conserve la règle, le fuseau IANA saisi par l'utilisateur, le message de départ, la configuration, les références au coffre et la version épinglée. Stocker également les échéances calculées en UTC. Chaque occurrence réserve un identifiant unique composé de la programmation et de son échéance UTC. L'admission de cette occurrence emprunte le chemin de lancement habituel avec une identité stable. Le redémarrage reprend une occurrence réservée en suivant son reçu.

Proposition pour les changements d'heure. Les règles quotidiennes, hebdomadaires et mensuelles suivent le calendrier du fuseau choisi. Une heure locale absente passe à la première heure valide suivante, une heure répétée utilise sa première occurrence, et un jour mensuel absent est sauté. Une règle « toutes les N heures » compte le temps écoulé depuis son ancre UTC.

Au démarrage, regrouper les échéances manquées en une seule, la plus récente, ou les marquer ignorées selon l'option choisie. Ignorer une occurrence si la précédente est encore active, sauf chevauchement autorisé. Un prérequis perdu, un secret absent ou un accord devenu invalide produit un événement dans « À traiter ». Suspendre la programmation empêche les nouveaux départs et conserve son état. Les échéances passées pendant une suspension volontaire restent ignorées.

La programmation possède une autorisation durable, liée à son propriétaire et au mandat enregistré sur la machine. Elle continue sans desktop connecté. Le retrait d'un desktop bloque ses commandes. La révocation du mandat suspend les futurs départs et l'administration locale doit pouvoir suspendre ou arrêter le service même pendant une panne de relais. Le comportement précis pendant une perte prolongée du relais dépend de la durée de validité de ce mandat. Les lancements autonomes restent soumis à la politique locale et au précontrôle.

« Toujours la dernière version » désigne la dernière version publiée par la bibliothèque de référence et reçue par le serveur. Afficher dans Operate la version reçue et sa date. Chaque nouvelle version repasse le précontrôle. Si ses permissions dépassent l'accord, suspendre les départs en attente d'une décision. Une bibliothèque desktop hors ligne peut retarder la publication d'une nouvelle version. Prévoir « Mettre à jour » pour diffuser une version épinglée en conservant la traçabilité du changement.

## Fournisseurs, journaux et mises à jour

Privilégier les clés API dédiées au serveur. L'administrateur les saisit localement dans le coffre, via une saisie masquée ou une entrée fournie par le gestionnaire de service. Chaque adaptateur reçoit son seul identifiant via le mécanisme qu'il prend en charge. Prévoir la rotation et exposer un statut d'authentification sans valeur secrète. Les comptes personnels demandent un parcours spécifique au fournisseur et une qualification sous le compte de service.

Le diagnostic et le précontrôle testent le binaire, la version qualifiée, les modèles, l'authentification et le profil de confinement sous le compte de service. Le chemin Codex délègue déjà le statut et le catalogue à Argentic. Il reste à qualifier le mode clé API du profil retenu sur les cibles serveur. L'adaptateur Claude lit déjà une clé dans `secrets` et vérifie son profil. Le profil contrôlé vérifié dans ce checkout est limité à Linux arm64. Un harnais indisponible apparaît avec sa cause et le serveur refuse le lancement tant qu'aucun profil qualifié ne le permet.

Journaliser l'identité de l'acteur, la cible, l'opération, la décision, l'horodatage et les identifiants de demande et d'exécution. Borner et faire tourner les journaux système. Les historiques de threads restent dans le stockage d'exécution soumis aux droits Operate. Les diagnostics évitent les corps de requêtes, les environnements de processus et les sorties brutes susceptibles de contenir des secrets.

Installer les mises à jour serveur avec des artefacts signés et une vérification préalable. Une mise à jour passe par un arrêt maîtrisé, une sauvegarde cohérente de SQLite et des artefacts référencés, puis des migrations contrôlées. Le coffre suit sa propre procédure de restauration. Tester la reprise des programmations et l'état des exécutions interrompues après redémarrage. Appliquer les règles de reprise du harnais, dont `INTERRUPTED` si le travail ne peut reprendre. Le retour à la version précédente dépend de la compatibilité du schéma ou d'une restauration documentée.

## Fondations dans le dépôt

| Dans le checkout | Réutilisation et travail restant |
| --- | --- |
| `src/services/macroPilot/nativeClient.ts`, `protocol.ts` dans le même dossier, et `src-tauri/src/commands/pilot_secrets/{native,manager,transport}.rs` | Association au compte, session d'appareil, clé d'instance, droits et révocation. Porter les fonctions nécessaires dans le service et ajouter l'association de la clé publique du serveur, l'amorçage CLI et le coffre utilisable au démarrage. Les droits et types de commandes des exécutions restent à définir. |
| `src/services/macroPilot/{runtime,contentHost,desktopConversationInteractions}.ts` et `src/composition/macroPilotDesktop.ts` | Producteur desktop, contenu par instance et contrôles de réponse. Reprendre les contrats de négociation, de révision et de reçu. Fournir des sources natives Rust pour que la production serveur tourne sans stores desktop. |
| `src/composition/macroConnectConsumer.ts`, `src/services/macroPilot/{consumerConnections,consumerTransport}.ts` et `src/components/connect/ConnectConsumerDialog.tsx` | Consommateur desktop et connexions bornées par cible. Étendre les lectures, événements et mutations pour Operate. Négocier ces opérations dans le contrat canonique et le relais. |
| `src-tauri/src/connect/{http,runtime,transfer_worker}.rs` et `src-tauri/src/db/connect_transfer/{staging,journal,publication}.rs` | Transport natif, quotas et modèles de réception par segments, reçus et publication. Le transfert actuel cible les conversations. Réutiliser les mécanismes génériques qui conviennent avec un contrat propre aux archives AgSDL et un cycle d'admission sans cession. |
| `src-tauri/examples/macro-headless.rs`, `src/services/{remoteKernelApi,providers/remote}.ts` et `docs/technical-architecture.md` §16 | Exemple de démarrage Rust, API HTTP de workspace et adaptateur frontend interne. Reprendre les services utiles après extraction. Le bearer expérimental ne représente ni une session d'appareil ni un droit d'accès par instance. |
| `src-tauri/src/agsdl_host_start_adapter030.rs`, `src-tauri/src/commands/agsdl_execution.rs` et `src-tauri/src/db/agsdl_execution/start030.rs` | Chemin de démarrage, reçus et opérations du moteur. D doit y intégrer la version archive et le contexte retenu. Extraire les effets Tauri du service utilisable par le démon. |
| `src/components/operate/OperateCenter.tsx`, `src/services/agsdl/runAccess030.ts` et `src/components/agsdl/WorkflowRunView030.tsx` | Lecture et graphe locaux. Brancher la projection distante sur les contrats d'E, avec adresses par instance. Ajouter les notifications via `src/components/ui/toastService.tsx`. |
| `src-tauri/src/agsdl_host_codex/mod.rs`, `src-tauri/src/agsdl_host_claude/{mod,profile}.rs`, `src-tauri/src/secrets/` et `src-tauri/src/local_backup.rs` | Catalogue, vérifications de profils, gestion native des identifiants et point de départ pour les sauvegardes. Qualifier les profils sans session graphique, le compartiment MCP et la restauration du stockage serveur. |

Les frontières de Connect sont décrites dans `docs/technical-architecture.md` §15.5 à §15.7, `docs/macro-connect-peer-architecture.md` et `docs/macro-pilot/content-contract-v2.md`. C définit la paire archive et réglages. Le document `step-c-design.md` détaille le passage à D pour `open_archive_bytes`, `retain` et `bind_scope`, puis la durée de vie des copies côté E.

## Livraison par pull request

| Lot | Dépendances | Critère de fin |
| --- | --- | --- |
| 1. Noyau et paquet interne | Après stabilisation des frontières de D. L'extraction du démarrage peut précéder D. | Démarrage Linux et macOS sans session graphique, racine privée, stockage, diagnostic et arrêt contrôlé. Le desktop garde le même service de lancement. |
| 2. Machine Connect et coffre de service | Lot 1. Contrat et relais Connect coordonnés. | Association par la CLI, catalogue, négociation, révocation pendant une requête et reconnexion. Le coffre est opérationnel après redémarrage. |
| 3. Réception d'une version | C et lot 2. | Transfert avec quotas, empreintes, réception interrompue et publication immuable. Rejet de contenu altéré et d'une association archive/réglages incohérente. |
| 4. Lancement distant | D et lot 3. | Précontrôle, harnais et confinement qualifiés, coffre MCP, consentement et démarrage Argentic. Rejouer une demande après perte du reçu retrouve la même exécution. La fenêtre de lancement affiche la machine et les blocages. |
| 5. Lecture et gestes dans Operate | E et lot 4. | Deux desktops voient la même exécution sur le serveur. Une question, une approbation et un agent interrompu sont traitables à distance. Couvrir réponse concurrente, expiration et reconnexion. |
| 6. Fichiers d'exécution | E et lots 4 et 5. | Liste et téléchargement bornés, y compris pendant une écriture ou une suppression. Vérifier confinement des chemins et nettoyage après suppression. |
| 7. Programmations sur le serveur | F et lots 4 et 5. | Programmer, suspendre et suivre les échecs à distance. Tester démarrage sans desktop, changement d'heure, panne et rattrapage sans doublon. |
| 8. Pause et entrées structurées | G pour la pause, H pour le formulaire. Lot 5 pour la pause et lot 4 pour le formulaire. Deux PR indépendantes. | Les gestes et le formulaire emploient les mêmes validations sur la cible distante et dans le chemin local. |
| 9. Distribution auto-hébergée | Après les lots 1 à 7. Les capacités G et H peuvent suivre. | Artefacts signés, installation, mise à jour et restauration testées sur les plateformes annoncées. Recette complète avec deux desktops, une panne de relais et un redémarrage du serveur. |

Après la distribution auto-hébergée, un lot séparé déploie le binaire existant sur un hôte géré et vérifie son association par la même CLI. Les lots suivants ajoutent la sauvegarde et la restauration d'une instance, les quotas par client et le retrait d'accès opérateur.

## Questions à trancher

- Quelles combinaisons OS, architecture, harnais et mode d'authentification passent la recette initiale, notamment Codex par clé API sous un compte de service ?
- Quel coffre permet un démarrage non interactif sous `systemd` et `launchd` ? Quelle procédure permet de restaurer les secrets et l'identité Connect sur un nouvel hôte ?
- Quels droits Connect ajouter et quels droits existants reprendre pour la lecture, l'approbation et la gestion des fichiers ? Le contenu des threads et les archives doivent-ils aussi être chiffrés de bout en bout dès la première livraison ?
- Combien de temps le serveur peut-il appliquer un mandat de programmation pendant une panne du relais ? La politique de révocation du propriétaire doit fixer cette durée.
- Peut-on lever définitivement un épinglage de version d'une machine perdue ? Comment présenter l'état de « Toujours la dernière version » quand la bibliothèque d'origine est hors ligne ?
- Quels plafonds de réception, de rétention et de téléchargement fixer avant la recette ? Quels événements méritent un canal push quand toutes les applications desktop sont fermées ?
