# Mise à jour A1 pour C, D et E

> Extension A2 : les nouvelles décisions et formes publiques sont définies dans
> [content-contract-v2.md](content-contract-v2.md). Ce document décrit la base
> 1.0 ; ses anciennes questions ne limitent pas le périmètre 2.0. Aucun support
> runtime 2.0 n’est annoncé avant intégration et négociation des consommateurs.

Cette correction appartient à la base `1.0` encore non publiée. Tous les
consommateurs mettent à jour le registre complet avant de communiquer ; aucune
compatibilité avec un schéma `1.0` antérieur de développement n'est promise.

## C, adaptateur desktop

- Projeter l'attention `reply` en `task.state: waiting_reply` et fournir
  `reply_context` ou le marqueur d'absence. Accepter `task.reply` sur la tâche
  avec permission `respond`, révision, contexte courant et idempotence avant
  l'appel au chemin de réponse existant.
- Conserver les tâches historiques ; omettre les runs non documentés et
  déclarer `projection.missing: ["run_history"]`. Une review non reconstructible
  utilise le marqueur `review`, sans inventer de SHA ni de run.
  Pour une tâche sans date de modification, publier `observed_at` à la place
  de `updated_at`, avec la date réelle d'observation du snapshot.
- Autoriser une décision sans `run_id` avec sa conversation et son message
  sources, et une approbation avec tâche mais sans run. Persister les identités
  et révisions nouvellement observées. Utiliser `observed_at` lorsque la date
  de création manque.
- Produire `resolved_by` distant, local ou inconnu selon les preuves
  disponibles. Garder `issued_by` authentifié sur toutes les commandes réseau.
- Pour un run connu en `waiting_reply`, utiliser une `taskRef` dans `waiting_on`.
  Appliquer les invariants de [compatibilité](compatibility.md), y compris la
  concurrence entre actions desktop et mobile.

## D, identité et relais privés

- Recharger les schémas A1 et transport ensemble. Inclure `task.reply` dans
  l'enveloppe `exchange` et lui appliquer `respond`, sans nouvelle route.
- Limiter les pages relayées aux ressources de supervision et exiger un scope
  d'instance à la demande. Les pages d'identité restent dans les routes D.
- Accepter les nouveaux états, projections, références et provenances dans les
  snapshots. Ne jamais accepter `origin: local` ou `unknown` comme `issued_by`.
- Conserver les contrôles d'acteur, session, instance, révocation et rejeu du
  [transport natif](native-transport.md) sur ce nouveau type de commande.

## E, client mobile privé

- Afficher une saisie simple pour `waiting_reply` avec `reply_context` ; envoyer
  `task.reply` avec `conversation_id`, `answer` et la révision de tâche affichée.
  Sans contexte, afficher l'attente sans action de réponse.
- Afficher les questionnaires et approbations sans dépendre d'un run ; conserver
  toute la référence reçue dans la commande. Afficher l'origine locale ou
  inconnue sans inventer de compte ni de date.
- Traiter `projection.missing` comme une projection incomplète explicite, pas
  comme une tâche absente ou un historique vide certain.

## Preuves attendues des consommateurs

Exécuter les fixtures A1 et transport avec leurs validateurs. Ajouter dans C les
tests ciblés du chemin de réponse simple, de concurrence locale/distante et de
projection d'une tâche historique avec attente active. D vérifie aussi le refus
de `task.reply` sans `respond` et après révocation. E vérifie l'affichage avec et
sans contexte. Ces tests d'intégration restent à réaliser dans leurs lots ; les
fixtures du contrat ne les remplacent pas.
