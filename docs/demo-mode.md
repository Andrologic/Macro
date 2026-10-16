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
- Quatorze tâches couvrant les sept états du produit, avec dépendances et
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

## Parcours blueprint → Operate

Dans Luma Mobile, ouvrir **Release mobile**, puis **Préparer le blueprint** au-dessus
du graphe. Pour chaque entrée, choisir une valeur par défaut ou **À fournir au
lancement**. Le modèle Macro AI est prérempli par défaut ; il peut aussi être
demandé à chaque utilisation. Ces attentes sont des métadonnées de conception
conservées avec le plan fictif, sans ajouter de propriétés au document AgSDL.

Chaque changement d’attente est conservé automatiquement dans les métadonnées
fictives. **Utiliser dans Operate** ouvre ensuite la préparation. Le mode
`Implement` est présenté comme **Operate** dans cette démo uniquement, avec une
bibliothèque de blueprint, une préparation centrale et le graphe à droite. Les
icônes Architect et Operate sont également adaptées uniquement dans ce mode.

Renseigner la version, sélectionner les paquets fictifs, choisir le modèle si
nécessaire et connecter le dépôt simulé. Une consigne peut être ajoutée pour cette
utilisation, séparément des instructions permanentes. Le démarrage reste bloqué
tant qu'une entrée obligatoire manque. La simulation capture source, annexes,
métadonnées et choix de lancement ; une nouvelle utilisation ne les modifie pas.
Les trois agents progressent, puis la simulation se termine. **Arrêter** empêche
toute progression ultérieure de cette exécution. Les anciennes exécutions restent
consultables à gauche. Le bouton **Architect** revient au blueprint source.

Ce parcours est une proposition d'interface limitée à ce blueprint fictif. Les
entrées ne sont pas encore un contrat générique de lancement relié au moteur.
Aucun provider, dépôt, installateur ou contrôle de signature réel n'est sollicité.
Les résultats affichés sont prédéfinis. Le parcours de référence est en français ;
les autres langues utilisent les libellés anglais pour les nouveaux contrôles.
Un rechargement remet la démo et les simulations à zéro.
