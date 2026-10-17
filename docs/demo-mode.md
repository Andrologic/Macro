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
- Quinze systèmes AgSDL 0.2, avec graphes et conversations : release, assistant client,
  compte rendu vocal, revue avant livraison, import de catalogue, diagnostic
  d’incident, remboursement accompagné, dossier éditorial, livraison multi-plateforme, rédaction
  supervisée, équipe support permanente, recherche en compétition, extraction avec
  correction, publication à double accord et cellule de crise.
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
- Quatorze tâches regroupées dans les quatre états de la file, avec dépendances et
  conversations contextualisées. Fichiers virtuels propres à chaque projet.
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
inconnues échouent explicitement, sans transfert vers le backend réel. Architecte
reste consacré à la conception : son en-tête regroupe l’enregistrement et l’export
dans un modal unique, à gauche de l’agrandissement. Les blueprints sont créés dans
les données fictives ; les exports téléchargent réellement un fichier local. Les
dialogues d’exécution et de fiche système restent retirés. Une exécution AgSDL complète, les approbations,
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


## Lancer un workflow dans Operate

Le bouton d’ajout de la file ouvre « Lancer un workflow » dans la démo.
Le premier écran demande de choisir un projet, avec une recherche et le nombre
de blueprints rattachés à chacun. Le catalogue affiche ensuite uniquement les
blueprints de ce projet : Release mobile et Compte rendu vocal pour Luma Mobile,
Revue avant livraison pour Atlas Studio, Import de catalogue pour Helio Data et
Remboursement accompagné pour Meridian Commerce. Changer de projet efface la
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
Le seul bouton d’action est « Lancer », désactivé tant que l’objectif ou un champ
obligatoire manque. Il attend la conservation des dernières valeurs avant de
lancer la simulation. Chaque workflow possède une copie du blueprint et ses
propres valeurs. Les instructions d’origine restent inchangées.

Le lancement ajoute une tâche et une conversation pour chaque agent dans
l’interface existante d’Operate. Une simulation fait progresser les agents
successivement, à raison d’une étape toutes les sept secondes. Ce scénario
permet de tester la navigation, les compteurs et les conversations ; il
n’interprète pas les branches, les approbations ou le parallélisme AgSDL.
Les nouveaux résultats sont fictifs. Aucune connexion ou opération Git réelle
n’est effectuée. Le rechargement de la page réinitialise les préparations et
les exécutions comme le reste de la démo. Le dialogue de production n’est pas
remplacé.
