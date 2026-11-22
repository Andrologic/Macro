# Systèmes agentiques : cahier des charges

Statut : décisions produit du 22 novembre 2026, recalibrées le 23 novembre
après la publication d'AgSDL 0.4.0 et 0.5.0 et l'ouverture des projets et des
archives par Argentic. Base de code de référence : `main` à la révision
`7523ec54`.

Ce document fixe la cible de Macro après son recentrage sur les systèmes
agentiques AgSDL. Il prévaut sur la [spécification fonctionnelle](functional-spec.md)
et l'[architecture technique](technical-architecture.md) lorsqu'ils divergent.
Ces deux documents seront réécrits au fil des étapes de réalisation décrites
plus bas, car une grande partie de leur contenu concerne des fonctions retirées.

## 1. Recentrage du produit

Macro abandonne l'édition et le développement logiciel assistés par IA. Il sert
désormais à concevoir, lancer, suivre et partager des systèmes agentiques décrits
en [AgSDL](agsdl-030.md) et exécutés par le moteur Argentic.

Le public visé a un minimum de culture technique sans être développeur.
L'interface montre l'essentiel et laisse le détail accessible à la demande.
Pour comprendre ce qui se passe, l'utilisateur interroge les agents plutôt que
de lire des écrans chargés.

Macro garde trois modes :

| Mode | Rôle |
| --- | --- |
| Architect | Concevoir un système : agents, outils, skills, flow, réglages. L'enregistrer en versions. On n'y lance rien. |
| Operate | Lancer des versions, suivre et déboguer les exécutions, répondre aux agents, programmer des lancements. |
| Chat | Conversations indépendantes, inchangées par ce chantier. |

Le mode Implement disparaît : Operate le remplace.

## 2. Vocabulaire

| Terme | Sens |
| --- | --- |
| Projet | Dossier d'Architect qui range des blueprints et leurs versions. Il n'est lié ni à un dépôt de code ni à un dossier choisi par l'utilisateur. |
| Blueprint | Un système agentique en cours de conception : un brouillon modifiable et la liste de ses versions. |
| Brouillon | Un dossier de projet AgSDL (`agsdl-project-1`) rangé dans les données de Macro : le manifeste `agsdl.json` et les fichiers des agents, du flow, des skills et des serveurs MCP. |
| Version | Un état figé et numéroté d'un blueprint (v1, v2…), avec une note facultative. Elle prend la forme d'une archive. |
| Archive | Le fichier `.agsdl` (`agsdl-archive-1`) d'une version : un zip standard qui contient tout ce qui doit voyager avec le système, avec un inventaire et une empreinte par fichier. |
| Réglages Macro | Ce que l'auteur règle pour Macro sans changer le document : threads masqués, indication du message de départ, mode de dossier, champs de lancement. Ils accompagnent chaque version dans un fichier propre à Macro. |
| Exécution | Un lancement d'une version, sur une machine. Plusieurs exécutions d'un même blueprint peuvent tourner en parallèle. |
| Thread | La conversation d'une instance d'agent dans une exécution. |
| Configuration de lancement | Les réglages propres à la machine qui lance un blueprint : dossier, modèles de remplacement, secrets, accord sur les permissions. |
| Programmation | Un lancement différé ou périodique, enregistré avec sa version, son message de départ et sa configuration. |
| Machine | Un ordinateur ou un serveur relié par Macro Connect, capable d'exécuter des systèmes. |

## 3. Décisions

### 3.1 Versions et stockage

- Macro stocke lui-même les blueprints et leurs versions dans ses données
  locales, sans Git. Une base locale indexe les blueprints, leurs versions et
  les exécutions et programmations qui les utilisent. Elle ne contient pas le
  système lui-même.
- Le brouillon est un dossier de projet AgSDL. C'est le seul format qui contient
  des skills complètes et les fichiers des serveurs MCP locaux.
- Architect modifie le brouillon. « Enregistrer une version » produit une
  archive `.agsdl` figée et une copie des réglages Macro. Une version n'est plus
  modifiable.
- Macro numérote lui-même ses versions. L'archive ne contient pas d'historique
  Git ; l'export avec historique, prévu par le format, viendra plus tard.
- Une version utilisée par une exécution ou une programmation ne peut pas être
  supprimée.
- Une exécution reste sur la version avec laquelle elle a été lancée. Un nouveau
  lancement propose la dernière version et permet d'en choisir une autre.
- Adapter un blueprint crée une copie à partir d'une version précise, en
  conservant sa provenance.
- On ne lance jamais depuis Architect, pas même un brouillon. Un raccourci
  « Enregistrer et lancer dans Operate » fige la version et ouvre la fenêtre de
  lancement dans Operate.
- La structure exacte des projets reste à affiner. L'hypothèse de départ : un
  projet contient un ou plusieurs blueprints, chacun avec ses versions.

### 3.2 Ce qu'on retire

On retire tout ce qui relève du développement logiciel :

- la branche de métadonnées `@macro`, sa synchronisation et le dossier `.macro`
  des projets ;
- Git dans l'interface : barre de pied de page, commits générés, conflits,
  flux de fusion ;
- les worktrees et la préparation d'espaces de travail par tâche ;
- les tâches de code d'Implement : file de tâches, fichiers modifiés, revue,
  fusion, commandes de projet, points de restauration du code ;
- l'éditeur de code et les diagnostics LSP ;
- les plans de développement non AgSDL d'Architect ;
- le registre de projets en tant que dépôts de code ;
- le terminal intégré, retiré de l'interface ;
- le panneau d'exécution d'Architect, puisque les lancements passent par Operate.

On garde le Chat, le moteur AgSDL et Argentic, les fournisseurs, les réglages,
MCP, les skills, les notifications, Macro Connect, la dictée, les mises à jour
et la sauvegarde locale. Macro Pilot est conservé sans évolution dans la
première version. La logique existante d'attention de la file de tâches est
réutilisée pour Operate.

Les blueprints AgSDL 0.3 existants sont importés une fois dans le nouveau
stockage. Les autres données de développement sont abandonnées.

Si AgSDL définit plus tard des mécanismes comparables aux worktrees, ils seront
traités dans ce cadre.

### 3.3 L'archive

Une version prend la forme d'une archive `.agsdl`, le format standard
d'AgSDL 0.5.0. C'est le même fichier qu'on lance, qu'on exporte et qu'on envoie
à une autre machine. Macro ne définit pas de format de paquet propre.

| Statut | Contenu |
| --- | --- |
| Dans l'archive | Manifeste et fichiers du projet ; contenus désignés par un chemin relatif ; skills complètes, avec tous leurs fichiers ; fichiers déclarés des serveurs MCP locaux ; noms des secrets attendus par chaque serveur. |
| À côté de l'archive, dans Macro | Réglages Macro de la version ; fiche d'identité (nom, numéro, note, date). |
| Déclaré, non inclus | Harnais et versions, modèles, programmes requis par les serveurs MCP, contenus désignés par une adresse absolue. |
| Jamais transmis | Valeurs des secrets, comptes des fournisseurs, dossier de travail et données de l'utilisateur, historique des exécutions, préférences d'affichage locales. |

- Argentic lit l'archive, vérifie son inventaire et ses empreintes, et garde une
  copie privée pour chaque exécution. Un agent relit donc les mêmes contenus
  même après un redémarrage.
- Les skills sont toujours copiées et figées. Modifier une skill impose une
  nouvelle version.
- Les programmes externes sont vérifiés au lancement, jamais installés.
- Le format 1 n'a pas de place pour les réglages d'une application. Un
  blueprint exporté voyage donc sans ses réglages Macro, et un blueprint
  importé reprend les valeurs par défaut. La question est posée dans
  [AgSDL#32](https://github.com/Andrologic/AgSDL/issues/32).
- Avant la première exécution d'une archive importée, Macro montre ce qu'elle va
  lancer et avec quelles permissions.

### 3.4 Ce qui se complète au lancement

- **Dossier de travail.** L'auteur choisit le mode dans Architect. Par défaut,
  chaque exécution reçoit un dossier propre créé par Macro, consultable depuis
  Operate. L'auteur peut demander un dossier choisi au lancement. Macro prévient
  si une autre exécution l'utilise déjà. Ce réglage fait partie des réglages
  Macro.
- **Harnais et modèles.** Macro vérifie que les harnais sont installés et
  connectés. Si un modèle manque, l'utilisateur choisit un remplaçant pour cet
  agent. Ce choix est enregistré dans l'exécution, pas dans la version.
- **Secrets.** Leurs noms viennent des déclarations du projet. Macro ne demande
  que ceux des serveurs MCP réellement utilisables par le flow, compte tenu des
  permissions des agents et des appels directs. Un serveur déclaré mais
  inutilisé ne demande rien. Les valeurs sont demandées au premier lancement et
  rangées dans le coffre local, associées au blueprint et non à une version.
  Elles sont modifiables depuis Operate.
- **Serveurs MCP locaux.** Macro vérifie les programmes qu'ils requièrent. Il
  lance leurs scripts depuis la copie qu'Argentic garde de la version, en
  lecture seule, avec le dossier de l'exécution comme dossier de travail. Un
  agent ne peut donc pas modifier ces scripts.
- **Permissions.** Au premier lancement d'une version, Macro affiche un résumé
  lisible de ce que le système pourra faire. L'accord est redemandé seulement si
  une nouvelle version élargit les permissions.

Ces réglages forment la configuration de lancement du blueprint. Elle est
réutilisée par défaut. Chaque exécution conserve une copie de ce qu'elle a
utilisé, et les programmations s'appuient sur elle.

### 3.5 La fenêtre de lancement

- Accès par le bouton « Lancer un système » d'Operate, ou par le raccourci
  d'Architect.
- Un message de départ en texte libre, avec une indication rédigée par l'auteur.
  Le champ disparaît si le système n'en a pas besoin.
- Une ligne de résumé « version · emplacement · moment », dépliable avec
  « Modifier » : version et notes, machine, moment (maintenant, plus tard,
  périodique), nom facultatif de l'exécution, dossier si l'auteur l'a demandé.
- Une zone « À régler avant de lancer », visible seulement s'il manque quelque
  chose. Chaque ligne se corrige sur place.
- Une étape d'accord sur les permissions au premier lancement d'une version.
- Après le lancement, rien ne s'ouvre automatiquement. Une confirmation
  propose « Voir l'exécution ».

### 3.6 La colonne de gauche d'Operate

Inspirée de T3 Code : ce qui a besoin de l'utilisateur est en haut, le reste
est rangé et replié.

| Section | Contenu | Unité affichée |
| --- | --- | --- |
| À traiter | Questions, approbations, agents interrompus, erreurs, exécutions terminées | Threads |
| En cours | Exécutions actives | Exécutions dépliables |
| Reportés | Threads reportés | Threads |
| Terminés | Exécutions terminées normalement, terminées par l'utilisateur ou en échec | Exécutions dépliables |
| Programmés | Programmations et leur prochaine échéance | Programmations |

- Un agent qui finit sa part au milieu d'une exécution ne remonte pas dans
  « À traiter ».
- Une question quitte « À traiter » dès qu'on y répond. Une exécution terminée y
  reste jusqu'à ce qu'on l'ouvre, comme un message non lu.
- Le plus récent est en haut.
- Chaque ligne indique l'agent, puis « système · exécution », le motif et le
  temps écoulé. Cliquer sur la ligne ouvre le thread. Cliquer sur « système ·
  exécution » ouvre le graphe de l'exécution.
- Un filtre limite l'affichage à un système et peut afficher les threads masqués.
  La recherche porte sur les noms des threads et des exécutions.
- Les exécutions de toutes les machines apparaissent dans la même colonne, avec
  leur emplacement.

### 3.7 Gestes sur les threads et les exécutions

Chaque geste a un nom distinct :

| Geste | Portée | Effet |
| --- | --- | --- |
| Interrompre | Un agent | L'agent s'arrête en plein travail. Le travail reste ouvert. Le thread reste dans « À traiter » avec le motif « Interrompu ». On le relance par un message ou par « Reprendre ». |
| Mettre en pause | Une exécution, depuis le menu du graphe | Plus aucun travail ne démarre, les travaux en cours sont interrompus. « Reprendre » relance l'exécution là où elle s'était arrêtée. |
| Suspendre | Une programmation | Plus aucun lancement ne part. La programmation est conservée. |
| Reporter | Un thread | Le thread passe dans « Reportés » jusqu'au moment choisi. L'exécution n'est pas affectée. |
| Terminer | Une exécution | Arrêt définitif, avec confirmation, par le Stop du moteur. |
| Supprimer | Une exécution terminée | Efface ses threads, son dossier propre et la copie de la version gardée par Argentic si plus aucune exécution ne l'utilise. Un dossier choisi par l'utilisateur n'est jamais touché. |

- Interrompre et Mettre en pause sont des gestes de l'opérateur, propres à
  Macro. L'auteur ne les écrit pas, et AgSDL n'a pas à les définir
  ([AgSDL#20](https://github.com/Andrologic/AgSDL/issues/20) et
  [AgSDL#21](https://github.com/Andrologic/AgSDL/issues/21), fermées). Ils
  restent compatibles avec la spécification actuelle :
  - un agent interrompu attend une question présentée à une personne, donc son
    temps machine ne décompte plus ;
  - le message de reprise passe par les livraisons `steer` ou `queue` ;
  - pendant une pause, Macro retarde seulement le démarrage des travaux, les
    livraisons et le routage.
- Ces gestes demandent un travail dans Argentic : garder un travail ouvert après
  l'interruption du tour du harnais, et retenir les démarrages d'une exécution.
- Pendant une pause, le délai d'une approbation continue de courir, car attendre
  une personne est le travail même de l'approbation. Macro signale les
  approbations qui risquent d'expirer avant la reprise.
- Codex ne reprend pas un travail après un redémarrage. Si Macro se ferme
  pendant une interruption ou une pause, les travaux concernés échouent avec
  `INTERRUPTED`, selon les règles de reprise d'AgSDL. Macro prévient à la
  fermeture.
- Un thread reporté revient dans « À traiter » dès qu'il se passe quelque chose,
  et n'envoie pas de notification entre-temps. Macro prévient si un délai de
  réponse expire avant la fin du report.

### 3.8 Threads masqués

- L'auteur masque un agent, avec toutes ses instances, par une case de sa fiche
  dans Architect. Un agent est visible par défaut.
- Le réglage fait partie des réglages Macro de la version et désigne l'agent
  par son identifiant logique. La source AgSDL ne change pas.
- Un thread masqué qui a besoin de l'utilisateur remonte dans « À traiter » avec
  une icône, puis redisparaît. Ses notifications suivent la même règle.
- On y accède par le graphe de l'exécution, où les agents masqués portent une
  icône et listent leurs instances, ou par le filtre de la colonne.
- Afficher un thread masqué dans une seule exécution est remis à plus tard.

### 3.9 Lancements différés et périodiques

- Les lancements se programment depuis Operate : une fois à une date, ou
  périodiquement avec des formules simples (chaque jour, certains jours de la
  semaine, un jour du mois, toutes les N heures).
- La programmation enregistre le message de départ et utilise la configuration
  de lancement. Chaque échéance crée une exécution nommée par sa date.
- Par défaut, une programmation garde sa version. Operate signale une version
  plus récente et propose « Mettre à jour ». L'option « Toujours la dernière
  version » existe.
- Sur une machine locale, une programmation ne part que si Macro est ouvert. Les
  échéances manquées donnent un seul lancement au démarrage suivant, sauf si la
  programmation demande de les ignorer.
- Si l'exécution précédente tourne encore, le lancement n'a pas lieu et Macro le
  signale, sauf option contraire.
- Un lancement qui échoue faute de prérequis remonte dans « À traiter ». La
  création d'une programmation vérifie que la configuration est complète.
- Les attentes à l'intérieur d'un flow sont hors périmètre. Elles dépendent de
  [AgSDL#22](https://github.com/Andrologic/AgSDL/issues/22).

### 3.10 Serveur Macro

- Le serveur est une machine de plus dans Macro Connect : un Macro sans
  interface, toujours allumé.
- Le choix « Où » de la fenêtre de lancement liste toutes les machines
  connectées : cet ordinateur, le serveur, un autre ordinateur.
- Une exécution vit sur la machine qui la fait tourner, conformément au principe
  de Connect. Operate lit son contenu à distance.
- Un lancement distant envoie l'archive, les réglages Macro, la configuration de lancement, les
  secrets nécessaires, rangés dans le coffre de la machine cible, et l'accord sur
  les permissions.
- Sur un serveur, seul le dossier propre à l'exécution est disponible.
- Les programmations visant le serveur y sont enregistrées, avec le fuseau
  horaire de l'utilisateur.
- On réalise d'abord un Macro sans interface que chacun installe sur sa machine
  ou son serveur. L'hébergement fourni par Macro viendra ensuite sur la même base.
- L'authentification des fournisseurs sur un serveur est à traiter plus tard.
  Des clés d'API sont préférables à des comptes personnels.

### 3.11 Champs précis au lancement

Un prototype permet à l'auteur de déclarer des champs de lancement. Le schéma
fait d'abord partie des réglages Macro. Operate affiche un formulaire et envoie la
valeur en JSON dans le message de départ. Le schéma passera dans le document si
[AgSDL#23](https://github.com/Andrologic/AgSDL/issues/23) aboutit.

## 4. Plan de réalisation

Chaque étape fait l'objet d'au moins une pull request. À chaque étape,
l'application compile, les tests passent et l'état modifié est vérifié
visuellement.

Les deux premières étapes sont réalisées. Le plan a été recalibré ensuite :
AgSDL 0.5.0 définit les dossiers de projet et les archives, et Argentic sait
les ouvrir. Le paquet maison prévu à l'origine disparaît.

| Étape | Contenu | Sections | État |
| --- | --- | --- | --- |
| 0. Retrait | Tout ce qui relève du code, sauf le stockage : tâches de code, fichiers modifiés, Git dans l'interface, éditeur, LSP, worktrees, terminal. Le mode Implement disparaît au profit d'Operate. | 3.2 | Réalisée |
| 1. Blueprints et versions | Stockage local, projets d'Architect, « Enregistrer une version », import unique des blueprints de `@macro`. Les versions sont encore des documents JSON. | 3.1, 3.2 | Réalisée |
| A. Intégration | Pull requests des étapes 0 et 1, après correction des tests qui échouent en parallèle et du budget de taille de `ChatZone`. | | |
| B. AgSDL 0.4.0 | Argentic à la révision `826170f`. L'éditeur et l'agent d'Architect produisent et valident des documents 0.4.0. Un blueprint 0.3.0 est converti au prochain enregistrement. Vérification sous macOS de l'ouverture d'un dossier et d'une archive, puis d'une exécution Codex réelle. | 3.1 | |
| C. Projet et archive | Le brouillon devient un dossier de projet, la version une archive `.agsdl` accompagnée des réglages Macro. Conversion des versions existantes. Import et export de dossiers et d'archives. Retrait de `@macro`, de `.macro` et du panneau d'exécution d'Architect. | 3.1 à 3.3 | |
| D. Lancement | Lancement d'une version depuis son archive. Configuration de lancement, fenêtre compacte, raccourci depuis Architect, secrets filtrés, serveurs MCP locaux lancés depuis la copie d'Argentic, accord sur les permissions. | 3.4, 3.5 | |
| E. Operate | Colonne de gauche, ligne « système · exécution », lien vers le graphe, filtre, threads masqués, Reporter, Terminer, Supprimer avec le nettoyage des copies d'Argentic, Interrompre avec son travail dans Argentic. | 3.6 à 3.8 | |
| F. Programmations | Planificateur local, section « Programmés », Suspendre, rattrapage et chevauchement, alerte de nouvelle version. | 3.7, 3.9 | |
| G. Pause d'exécution | « Mettre en pause » depuis le menu du graphe, avec son travail dans Argentic. | 3.7 | |
| H. Champs de lancement | Prototype de formulaire déclaré par l'auteur. | 3.11 | |

La conception du serveur (section 3.10) avance en parallèle, sous forme d'un
document de conception, avant toute réalisation.

## 5. Plus tard

- Réalisation du serveur auto-hébergé, puis hébergement fourni par Macro.
- Attentes à l'intérieur d'un flow.
- Affichage d'un thread masqué dans une seule exécution.
- Envoi de fichiers vers une exécution distante.
- Place de marché de blueprints.

## 6. Questions ouvertes

### Dans AgSDL

Une question relève d'AgSDL si l'auteur doit pouvoir l'écrire dans le document,
ou si deux applications doivent se comporter de la même façon pour qu'un même
document garde le même sens. Les gestes de l'opérateur relèvent de Macro.

| Issue | Sujet | État |
| --- | --- | --- |
| [#22](https://github.com/Andrologic/AgSDL/issues/22) | Attendre à l'intérieur d'un flow | Ouverte |
| [#23](https://github.com/Andrologic/AgSDL/issues/23) | Déclarer les entrées d'une exécution | Ouverte |
| [#24](https://github.com/Andrologic/AgSDL/issues/24) | Déclarer les identifiants et programmes requis | Fermée : les déclarations du projet 0.5.0 suffisent |
| [#25](https://github.com/Andrologic/AgSDL/issues/25) | Paquet portable | Réalisée : archive `.agsdl` |
| [#26](https://github.com/Andrologic/AgSDL/issues/26) | Métadonnées d'application qui voyagent avec un document | Fermée : chaque application garde ses réglages dans son propre fichier |
| [#32](https://github.com/Andrologic/AgSDL/issues/32) | Réglages d'une application dans une archive | Ouverte |

### Côté produit

- Structure exacte des projets d'Architect.
- Ce qu'on garde de l'interface actuelle et les régressions introduites par
  l'intégration d'AgSDL, à examiner en direct dans l'application.
