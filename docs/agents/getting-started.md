# Vérifier un premier système dans Macro

Le [parcours utilisateur](../user-guide/getting-started.md) construit un système AgSDL qui extrait des actions d’une note de réunion. Utiliser un projet d’essai modifiable et des données fictives. Pour intervenir sur le code de Macro, suivre les [instructions du dépôt](../../AGENTS.md).

## Conception et sauvegarde

1. Ouvrir le projet dans Architect et créer un système. Relever le projet et le document sélectionnés avant toute édition.
2. Dans la conversation de conception, utiliser les outils AgSDL exposés par la session. Lire le document courant avant de proposer sa modification. En cas de conflit de révision, relire le document avant de reprendre.
3. Vérifier dans le graphe qu’un agent reçoit la note et que ses instructions couvrent le cas d’une action sans responsable. Enregistrer dans le projet, rouvrir le système et vérifier la définition relue.

## Exécution et supervision

Si la demande inclut un essai du système, lancer le profil pris en charge depuis le panneau d’Architect. Relever le refus natif si un prérequis manque. [Contrat d’exécution AgSDL 0.3](../agsdl-030.md)

Après admission, conserver l’identifiant d’exécution et la source capturée. Ouvrir cette exécution dans Operate. Pour vérifier une réponse d’agent, sélectionner l’instance correspondante et lire les messages disponibles. Si une demande humaine est ouverte, vérifier son rattachement à cette exécution avant de transmettre la décision de l’utilisateur.

Rapporter séparément le document relu, l’exécution admise et le résultat observé. Si la lecture devient périmée, attendre une observation fraîche avant de conclure ou de répondre. Une demande encore ouverte ou une trace partielle doit figurer dans le compte rendu.

[Retour à l’index agents](README.md)
