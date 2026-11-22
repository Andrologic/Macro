# Vérifier un premier système dans Macro

Le [parcours utilisateur](../user-guide/getting-started.md) construit un système AgSDL qui extrait des actions d’une note de réunion. Utiliser un projet d’essai modifiable et des données fictives. Pour intervenir sur le code de Macro, suivre les [instructions du dépôt](../../AGENTS.md).

## Conception et sauvegarde

1. Créer un projet local dans la bibliothèque d’Architect, puis un blueprint. Relever leurs identifiants avant toute édition.
2. Dans la conversation de conception, utiliser les outils AgSDL exposés par la session. Lire le document courant avant de proposer sa modification. En cas de conflit de révision, relire le document avant de reprendre.
3. Vérifier dans le graphe qu’un agent reçoit la note et que ses instructions couvrent le cas d’une action sans responsable.
4. Enregistrer une version avec une note identifiable. Modifier le brouillon, puis rouvrir la version après redémarrage. Comparer la définition relue à celle qui avait été figée. Vérifier qu’une adaptation de cette version conserve sa provenance.

## Suivi d’une exécution existante

Pour une exécution déjà admise, relever son identifiant et sa source capturée. Ouvrir cette exécution dans Operate. Pour vérifier une réponse d’agent, sélectionner l’instance correspondante et lire les messages disponibles. Si une demande humaine est ouverte, vérifier son rattachement à cette exécution avant de transmettre la décision de l’utilisateur.

Rapporter séparément le document relu, l’exécution admise et le résultat observé. Si la lecture devient périmée, attendre une observation fraîche avant de conclure ou de répondre. Une demande encore ouverte ou une trace partielle doit figurer dans le compte rendu.

[Retour à l’index agents](README.md)
