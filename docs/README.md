# Documentation de Macro

Macro conserve ici les sources de sa documentation pratique. Choisissez le
parcours correspondant à votre usage.

| Vous voulez… | Commencez ici |
| --- | --- |
| Utiliser Macro et réaliser une première modification | [Guide utilisateur](user-guide/README.md) |
| Exécuter un travail comme agent dans Macro | [Documentation agents](agents/README.md) |
| Développer Macro ou contribuer au dépôt | [Contribution](../CONTRIBUTING.md) et [développement](../DEVELOPMENT.md) |

## Deux niveaux de lecture

Le [guide de prise en main](user-guide/getting-started.md) accompagne une personne
dans l'interface. Il explique les actions, leur résultat et les problèmes
courants, avec un exemple que l'on peut reproduire sur un dépôt d'essai.

La [prise en main agents](agents/getting-started.md) décrit le même travail sous
forme de préconditions, de décisions et de critères de réussite. Son index
oriente ensuite vers les contrats détaillés selon le sujet. Un agent qui
contribue au code de Macro commence également par [AGENTS.md](../AGENTS.md).

## Références existantes

Ces documents gardent leur rôle et leur emplacement :

- [Installation](../INSTALL.md) et [support](../SUPPORT.md).
- [Spécification fonctionnelle](functional-spec.md), pour le comportement cible.
- [Architecture technique](technical-architecture.md), pour les responsabilités
  des composants.
- [Configuration](configuration.md), pour les fichiers, les scopes et les
  approbations.
- [Stratégie de test](test-strategy.md) et [CI](ci.md), pour les validations.
- [Versions publiées](../CHANGELOG.md) et [roadmap](roadmap.md), pour distinguer
  les livraisons des travaux prévus.

La spécification peut décrire une capacité cible encore en cours de réalisation.
Un guide pratique décrit le comportement disponible dans la version qu'il couvre.

## Entretenir les guides

Les premiers guides sont rédigés en français. Les libellés cités correspondent
à l'interface française ; les modes Architect, Implement et Chat gardent leur nom.

La base rédactionnelle initiale est la révision `1d983877` de `develop`,
consultée le 20 octobre 2026. Son manifeste indique la version 0.1.8. Les étapes et les libellés ont été relus
dans le code et les traductions. Le parcours complet doit encore être essayé
dans l'application avant une publication comme tutoriel vérifié sur une version
distribuée.

Pour ajouter ou modifier une procédure :

1. Choisir son public et ajouter la page dans `user-guide/` ou `agents/`.
2. Décrire un résultat précis. Pour les humains, donner les actions dans
   l'interface et les résultats attendus. Pour les agents, préciser les
   préconditions, les branches de décision, les preuves de réussite et la reprise.
3. Vérifier les libellés et le comportement dans le code, puis essayer le parcours
   dans l'application quand il dépend de l'interface. Noter la version utilisée
   et les limites de validation dans la PR.
4. Ajouter la page à l'index du parcours et vérifier ses liens relatifs.
5. Modifier le guide dans la même PR que la fonctionnalité qui change son usage.
   Renvoyer aux contrats techniques existants plutôt que recopier leur contenu.

Les exemples et les captures utilisent des données fictives. Les secrets, les
conversations privées et les chemins propres à une machine restent hors du dépôt.

## Publication sur le site

Ce dépôt est la source éditoriale. La destination prévue pour la documentation
publique est `macro.andrologic.ai/docs`. Le projet du site gérera la présentation,
la navigation et la recherche en récupérant ces fichiers à une révision Git
identifiée. L'import et la publication ne sont pas encore configurés.

Conservez des liens Markdown relatifs et des noms de fichiers stables. Les
futures captures auront leur place dans `user-guide/images/`. Le site devra
résoudre les liens vers les références qui restent ailleurs dans le dépôt,
sans maintenir une seconde copie éditable des guides.
