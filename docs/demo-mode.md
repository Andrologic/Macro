# Mode démo intégré

Le mode démo charge les composants, les stores et la navigation de Macro. Un
backend en mémoire remplace les appels Tauri avant le chargement de l'application.
Il permet de travailler l'interface avec des données fictives sans ouvrir un
profil utilisateur ou un dépôt réel.

## Lancement

```sh
bun run dev:demo
```

Ouvrir `http://127.0.0.1:1438/`. Recharger la page restaure le scénario initial,
y compris les préférences.
Le port est strict pour éviter d'ouvrir accidentellement une autre instance.

Le lancement actuel utilise le frontend réel dans le navigateur. Ce mode refuse
de démarrer dans une fenêtre native qui possède déjà un backend Tauri. Un
lancement natif devra isoler le profil avant le démarrage du backend.

## Scénario et interactions

- Quatre projets fictifs : Luma Mobile, Atlas Studio, Helio Data et Meridian Commerce.
- Seize blueprints de projet AgSDL 0.2, avec graphes et conversations : release, assistant client,
  compte rendu vocal, revue avant livraison, import de catalogue, diagnostic
  d’incident, remboursement accompagné, dossier éditorial, livraison multi-plateforme, rédaction
  supervisée, équipe support permanente, recherche en compétition, extraction avec
  correction, publication à double accord, cellule de crise et reprise audio. Deux
  blueprints communs, Assistant et Chantier coordonné, complètent ces exemples.
- Graphes avec branches conditionnelles, contrôles parallèles et regroupement,
  points de validation humaine, traitement des erreurs et boucle de diagnostic.
- Compositions paramétrées réutilisées pour plusieurs agents, avec des sorties
  nommées et des graphes de détail. Les compositions ne sont pas imbriquées,
  conformément au contrat 0.2.
- Agents persistants, messages de steering, décisions nommées, limites de visites,
  configurations choisies à l’initialisation et ressources structurées.
- Compétition avec premier résultat acceptable et arrêt confirmé des autres travaux.
- Résultat JSON contraint par `valueSchema`, correction sur `OUTPUT_CONSTRAINT`
  dans le même agent et chemin distinct pour les erreurs techniques.
- Deux approbations successives sur une même publication à effets externes.
- Cellule de crise : trois analystes en compétition, décision à trois issues, même
  composition utilisée pour trois spécialistes, double accord, effet externe,
  contrôles parallèles obligatoires et transmission de leurs résultats nommés.
- Les cartes distinguent les types de blocs et indiquent les compétences, les
  résultats contraints, la sélection de configuration et les effets externes déclarés.
  Le survol précise leur sens, sans prétendre à une prise en charge à l’exécution.
- Compétences partagées, contenus référencés et équipe sans graphe imposé.
- Soixante-quinze tâches réparties entre dix-neuf exécutions fictives, dont une
  édition archivée. Elles restent individuelles dans les quatre états de la file,
  avec des dépendances et des conversations propres à chaque situation. Fichiers virtuels propres à chaque projet.
- Consultation et modification des instructions et du modèle d'un agent.
- Tâches avec états et conversations, navigation entre les modes.
- Composeur normal et réponses locales simulées, sans appel à un fournisseur.
- Paramètres, catalogue de modèles, skill et serveur MCP fictifs.
- Terminal simulé. Aucune commande n'est exécutée.
- Fichiers et modifications conservés uniquement en mémoire.

Les vues sont celles du produit actuel. Ce socle sert à retravailler ensuite
Architect, Operate et les parcours d'export dans l'application elle-même.

## Limites actuelles

Toutes les commandes de Macro ne sont pas encore simulées. Les opérations
inconnues échouent explicitement, sans transfert vers le backend réel. Architect
reste consacré à la conception. Son en-tête propose l’export à gauche de
l’agrandissement. Les blueprints sont créés dans les données fictives ; les exports
téléchargent réellement un fichier local. Le graphe d’exécution est accessible
depuis le menu d’une tâche dans Operate. Une exécution AgSDL complète, les approbations,
les intégrations externes, la dictée, la sauvegarde et la mise à jour de
l'application ne sont pas reproduites. Les réponses du chat sont prédéfinies.

Ne pas qualifier ce mode de démonstration exhaustive avant d'avoir simulé et
vérifié ces parcours. Les journaux `[demo:unsupported]` identifient les commandes
à compléter. Ajouter leurs contrats dans `src/demo/runtime.ts` et des fixtures
dans `src/demo/fixtures.ts`, sans ajouter de contournement dans les composants.

## Isolation et vérification

Le mode nécessite `DEV` et `VITE_MACRO_DEMO=1`. La compilation de production élimine
son import. Les préférences et les stockages web sont en mémoire. Les requêtes
HTTP natives sont interceptées et les requêtes web externes sont refusées. Le
catalogue externe de modèles reçoit une réponse locale vide ; les modèles de
la démo sont fournis explicitement.

```sh
bun test src/demo/runtime.test.ts
bun run typecheck
```

Pour une vérification visuelle, changer de projet, ouvrir un agent, modifier ses
instructions et son modèle, enregistrer, envoyer un message, parcourir les tâches
et les paramètres, puis recharger la page. Les données initiales doivent réapparaître.

## Préparation du blueprint dans Architect

Dans Luma Mobile, ouvrir **Release mobile**, puis **Préparer le blueprint** au-dessus
du graphe. Pour chaque entrée, choisir une valeur par défaut ou **À fournir au
lancement**. Le modèle Macro AI est prérempli par défaut ; il peut aussi être
demandé à chaque utilisation. Ces attentes sont des métadonnées de conception
conservées automatiquement avec le plan fictif, sans ajouter de propriétés au
document AgSDL.

Dans cette démo, `Implement` porte le nom **Operate**. Il conserve l’interface
existante : liste des tâches à gauche, espace de travail au centre et modifications
de fichiers à droite. Les écrans expérimentaux de préparation et de simulation
qui avaient remplacé ces panneaux ont été retirés. La préparation d’un workflow
se fait depuis le bouton d’ajout d’Operate, sans quitter cette disposition.


## Blueprints communs à Macro

Dans Architect, la section « Bibliothèque Macro » apparaît au-dessus des projets.
Son titre et celui de « Tous les projets » permettent de replier chaque section
indépendamment. Le choix est conservé pendant la session de démonstration ; une
recherche révèle temporairement les
résultats des sections repliées.
Elle contient Assistant et Chantier coordonné, avec leur propre graphe et leur
conversation. Les menus de plan existants permettent de renommer ces blueprints,
de choisir leur icône et de les archiver. Le bouton + ouvre un nouveau plan dans
cette bibliothèque. Les plans vides ne sont pas proposés au lancement.

Dans cette démo, la bibliothèque utilise un workspace synthétique isolé
`/demo/macro` et le même stockage de plans que les projets. Elle est exclue des
projets proposés dans Operate. Le catalogue « Communs à Macro » est construit à
partir des documents édités dans Architect, sans copie indépendante des prompts.
Un nouveau lancement reprend la dernière version enregistrée ; les préparations
existantes conservent leur snapshot. Cette bibliothèque de démonstration ne crée
pas de stockage global ni de projet dans le runtime de production.

## Lancer un workflow dans Operate

Le bouton d’ajout de la file ouvre « Lancer un workflow » dans la démo.
Le premier écran demande de choisir un projet, avec une recherche. Le catalogue affiche ensuite les
blueprints de ce projet : Release mobile et Compte rendu vocal pour Luma Mobile,
Revue avant livraison pour Atlas Studio, Import de catalogue pour Helio Data et
Remboursement accompagné pour Meridian Commerce. Une section « Communs à Macro »
propose Assistant et Chantier coordonné dans tous les projets. Changer de projet efface la
sélection du blueprint et les champs saisis. Les workflows à lancer sont
eux aussi limités au projet choisi. Le backend simulé refuse une préparation
avec un blueprint d’un autre projet. Les champs de préparation viennent
des métadonnées de leurs blueprints, dont les choix effectués dans Architect.

Le blueprint est le modèle réutilisable ; le workflow est ce qu’on prépare
puis lance à partir de ce modèle. La saisie est conservée automatiquement,
même incomplète, dans un brouillon unique. Fermer le dialogue attend la dernière
sauvegarde ; la prochaine ouverture permet de retrouver ce brouillon dans
« Workflows à lancer », sous le même projet. Une erreur de sauvegarde reste
visible et empêche la fermeture tant que la saisie n’est pas conservée.
Le seul bouton d’action est « Lancer », désactivé tant qu’un champ demandé par
le blueprint manque. Aucun objectif ou réglage supplémentaire n’est imposé par
Macro. Les valeurs déjà définies dans le blueprint sont héritées sans afficher
de contrôle ; seuls les champs restant à renseigner sont visibles. Les listes
affichent les noms sans descriptions ni compteurs. Il attend la conservation des dernières valeurs avant de
lancer la simulation. Chaque workflow possède une copie du blueprint et ses
propres valeurs. Les instructions d’origine restent inchangées.

Le lancement ajoute une carte indépendante et une conversation par étape de travail ou point d’accord dans
l’interface existante d’Operate. Les tâches restent affichées individuellement,
avec leurs statuts et leurs dépendances. La liste ne comporte pas de titres de
catégories : l’ordre est À lancer, En attente, En cours, puis Terminées, comme
les filtres du haut. Le bouton filtre propose « Archives », « Sans interaction »
et « Tâches bloquées ». Ces cases se combinent et restent mémorisées entre les
modes. Les tâches bloquées sont masquées par défaut, sans entrée parent ni
regroupement par workflow. Elles réapparaissent lorsqu’elles peuvent démarrer.
Les tâches sans interaction sont masquées par défaut. Les exécutions déjà présentes sont des captures de situations, sans fournisseur actif. Les nouveaux lancements suivent leur simulation écrite. Les questions,
approbations, erreurs et actions de lancement restent visibles. Les archives
peuvent s’ajouter à la liste avec une pastille dédiée. Les compteurs de statuts
suivent les filtres sans doublons ; ceux des projets dénombrent les tâches actives.

Le clic droit d’une tâche, ou son menu à trois points, propose « Voir le workflow ». Le graphe s’ouvre en modal avec le bloc concerné sélectionné et les états des tâches visibles. Les associations des exemples sont explicites. Pour un workflow lancé, le graphe est capturé au lancement : modifier ensuite le blueprint dans Architect ne change pas cette capture. Chaque tâche appartient au vrai graphe de son blueprint, y compris les exemples de la Bibliothèque Macro exécutés dans un projet. Une ancienne édition conserve ses propres associations et ne renvoie pas aux tâches de l’édition actuelle. Les appels de composition sont liés aux blocs du graphe principal, sans inventer un état unique pour leur modèle partagé. Les étapes techniques déjà parcourues ont un indicateur dans le graphe et ne créent pas de tâche dans la liste.

Le blueprint Assistant démarre en attente. La consigne se donne directement dans
la tâche, après le lancement. Les autres blueprints utilisent leurs valeurs
héritées. Une simulation avance toutes les sept secondes sur un parcours écrit pour chaque exemple. Les contrôles parallèles démarrent ensemble, la synthèse attend leurs résultats et les questions restent en attente de réponse. Le rédacteur persistant reste actif jusqu’à la transmission de la consigne. Une relecture ou une approbation ne se termine pas automatiquement ; écrire un message ordinaire ne vaut pas accord. Ces parcours servent à tester la navigation, les compteurs et les conversations. Ils ne constituent pas un interpréteur AgSDL : les autres branches restent visibles dans le graphe, et aucune approbation ni aucun effet externe réel ne sont exécutés.
Les nouveaux résultats sont fictifs. Aucune connexion ou opération Git réelle
n’est effectuée. Le rechargement de la page réinitialise les préparations et
les exécutions comme le reste de la démo. Le dialogue de production n’est pas
remplacé.

## Organiser les blueprints dans les projets et la bibliothèque

Les projets du navigateur Architect utilisent une icône de couches par défaut.
Leur bouton + et leur menu contextuel proposent « Nouveau dossier ». La Bibliothèque
Macro propose la même organisation, avec ses propres dossiers et sous-dossiers. Les dossiers
visuels peuvent contenir des sous-dossiers, être renommés, repliés ou déplacés.
Le clic droit sur un dossier propose « Nouveau blueprint » et « Nouveau sous-dossier ».
Un nouveau blueprint ouvre un brouillon AgSDL distinct dans ce dossier, sans
réutiliser ni déplacer un brouillon vide déjà présent ailleurs. Retirer un dossier
remonte ses blueprints et ses sous-dossiers dans son parent, sans les supprimer.

Un blueprint ou un dossier se déplace sur un autre dossier par glisser-déposer, et revient à la racine
en le déposant sur la ligne du projet ou l’en-tête de la Bibliothèque Macro. Son menu
propose aussi « Déplacer vers… ». Un déplacement reste dans le même projet ou dans
la Bibliothèque Macro, sans transfert entre ces espaces. Un dossier ne peut pas être déplacé
dans lui-même ni dans l’un de ses descendants. Les anciens dossiers sans parent
restent à la racine. Les identités incluent la branche pour
ne pas confondre deux plans portant le même identifiant. La recherche révèle les
plans correspondants dans les dossiers repliés. Les épingles restent des raccourcis.

Cette organisation est une préférence locale du navigateur, conservée lors des
changements de mode. Elle ne modifie ni les fichiers Git ni les documents AgSDL
et n’est pas synchronisée entre machines. Comme les autres données de la démo,
elle est réinitialisée au rechargement complet.


## Menus du panneau gauche

Le clic droit est disponible sur les projets, la Bibliothèque Macro, les dossiers,
les blueprints, les tâches d’Operate et les conversations de Chat. Il ne change
pas l’élément actif. Les actions sont les mêmes que dans le menu de l’élément.
Le fond du panneau et les en-têtes généraux proposent les actions du mode courant.
Les champs de recherche gardent le menu d’édition de texte du navigateur.
Les menus sont affichés hors des listes défilantes pour rester visibles, même en
bas de liste. Un seul s’ouvre à la fois ; Échap, le clic extérieur ou le défilement
le referment. Les flèches permettent de parcourir les actions disponibles.
