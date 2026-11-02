# Exécuter une première tâche dans Macro

## Périmètre et résultat

Ce protocole détaille le parcours du
[guide utilisateur](../user-guide/getting-started.md) pour un agent exécutant
une tâche dans l'application desktop locale. L'exemple crée un seul fichier
`macro-quickstart.md` dans un dépôt d'essai.

La livraison attendue de l'agent est un diff relu et un compte rendu des
vérifications. L'utilisateur valide ensuite les changements, crée le commit et
termine la tâche dans Macro. Une demande explicite peut confier ces actions à
l'agent, dans les limites des outils et des permissions de sa session.

Si le travail porte sur le code de Macro lui-même, charger d'abord les
[instructions de contribution du dépôt](../../AGENTS.md).

## 1. Établir le contexte d'exécution

Identifier le projet cible, la tâche active, le mode courant et le dossier
d'exécution réellement fourni par Macro. Distinguer un dépôt utilisé comme
contexte d'un dépôt autorisé en écriture.

| Précondition | Preuve attendue | Si elle manque |
| --- | --- | --- |
| Intention définie | Fichier attendu, contenu demandé et critères d'acceptation identifiés | Demander la précision qui conditionne l'édition |
| Projet modifiable | Projet sélectionné et droits d'écriture autorisés dans le runtime | Faire traiter la configuration ou la permission requise |
| Fournisseur et modèle prêts | Une requête peut aboutir et les outils nécessaires sont exposés | Rapporter l'erreur du fournisseur ou l'outil manquant |
| Tâche Feature préparée | Branche et worktree de la tâche résolus après le lancement | Attendre la préparation ou diagnostiquer son échec |
| Identité du dépôt confirmée | Dossier courant, branche et état Git connus | Relire le contexte avant toute édition |

Utiliser les outils effectivement exposés à la session et leurs schémas.
La présence d'un outil dans le dépôt source ne signifie pas qu'il est disponible
pour ce mode, ce fournisseur ou cette politique projet.

Dans le code de Macro, le catalogue est défini dans
[`macroToolRegistry.ts`](../../src/shared/macroToolRegistry.ts) et les définitions
IA sont assemblées dans
[`toolDefinitions.ts`](../../src/services/ai/toolDefinitions.ts). Ces fichiers
servent à vérifier un contrat d'outil lors d'une contribution ou d'un diagnostic.
Le schéma reçu dans la session gouverne l'appel réel.

L'étape est terminée lorsque le dossier cible et la branche sont établis,
et que les préconditions nécessaires à l'édition sont satisfaites.

## 2. Choisir le parcours

Pour l'exercice, l'utilisateur crée une tâche autonome de type Feature avec le
point de départ Nouveau travail dans Implement. Macro crée d'abord un brouillon ;
le premier message déclenche la préparation et l'exécution. Consulter
[`CreateImplementTaskDialog.tsx`](../../src/components/tasks/CreateImplementTaskDialog.tsx)
et [`TaskQueue.tsx`](../../src/components/tasks/TaskQueue.tsx) pour diagnostiquer
cette admission.

Une Feature travaille dans une branche et un worktree dédiés, depuis la branche
de développement configurée. Une tâche Direct travaille dans le dossier source.
Un projet en édition directe sans Git suit encore un autre contrat. Identifier
le type réel avant d'appliquer une procédure de commit ou de fusion.

Pour un chantier comportant plusieurs tâches, utiliser le parcours Architect.
La discussion du besoin précède la génération explicite de la stratégie et sa
validation. Le [contrat fonctionnel](../functional-spec.md) décrit cette séquence.

L'étape est terminée lorsque le parcours choisi correspond au type de tâche
et au périmètre demandé.

## 3. Produire le changement borné

1. Lire les instructions applicables au projet cible et l'état de travail.
2. Vérifier si `macro-quickstart.md` existe. S'il existe, demander un autre nom
   comme le prévoit la consigne de l'exercice.
3. Créer ce seul fichier avec le titre et la phrase demandés.
4. Inspecter le diff et l'état Git dans le worktree de la tâche.
5. Vérifier le contenu et l'absence de fichiers modifiés hors périmètre par
   cette exécution. Les changements préexistants restent attribués à leur auteur.

Le critère de réussite de l'exercice est un fichier ajouté avec le contenu
attendu, sans changement supplémentaire produit par l'agent. Une lecture du
fichier et du diff suffit pour cette modification documentaire. Pour du code,
choisir les validations pertinentes dans les instructions du projet cible.

Une commande lancée ou une session terminal créée ne prouve pas que la commande
est terminée. Attendre son résultat avant d'annoncer une vérification réussie.

## 4. Transmettre le résultat à la revue

Rendre un compte rendu contenant :

- le fichier modifié et le résultat obtenu ;
- les vérifications exécutées et leur résultat observé ;
- toute limite ou demande d'approbation encore ouverte ;
- l'action suivante attendue de l'utilisateur.

Dans ce premier exercice, s'arrêter avant le commit pour laisser l'utilisateur
ouvrir le diff dans Changements et utiliser les actions de validation.
L'agent termine sa livraison lorsque le changement est disponible pour la revue
et que les vérifications sont rapportées fidèlement.

## 5. Distinguer livraison, commit et intégration

| État | Preuve |
| --- | --- |
| Changement produit | Diff présent dans le worktree attendu |
| Vérifications réussies | Résultats observés des contrôles pertinents |
| Revue utilisateur effectuée | Diffs ouverts puis changements validés dans Macro |
| Commit créé | Identifiant de commit retourné et état Git correspondant |
| Tâche terminée | Finalisation réussie et état durable de la tâche terminé |
| Intégration locale réussie | Changement présent sur la branche d'intégration configurée |

Le panneau Changements sépare Commit et Terminer la tâche. La finalisation
vérifie le workflow de fusion ; un blocage peut maintenir la tâche ouverte
après la création du commit. Voir
[`FileChangesPanel.tsx`](../../src/components/implement/FileChangesPanel.tsx),
[`useFileChangesStore.ts`](../../src/stores/useFileChangesStore.ts) et le
[contrat de workflow](../task-plan-workflows.md).

Pour une Feature autonome, la branche d'intégration est la branche de
développement configurée pour le projet. Pour une tâche issue d'un plan, lire
la cible du plan et les enregistrements d'exécution. Déduire la cible depuis le
contexte durable de la tâche plutôt que supposer un nom de branche.

Une intégration locale et un push sont deux opérations distinctes. Rapporter
uniquement les états dont la preuve est disponible.

## Reprise après un blocage

| Situation | Reprise attendue |
| --- | --- |
| Préparation interrompue | Relire l'état durable de la tâche et les branches/worktrees existants avant une nouvelle tentative |
| Permission ou approbation en attente | Rapporter la demande et attendre la décision prévue par le runtime |
| Diff modifié après revue | Actualiser le diff et refaire la validation sur le nouveau contenu |
| Commit créé, finalisation échouée | Conserver le commit, inspecter le blocage et reprendre la finalisation |
| Finalisation partielle sur plusieurs dépôts | Identifier les dépôts déjà terminés et reprendre les autres à partir du journal |
| Configuration invalide | Lire le diagnostic et corriger le document concerné via le contrat de configuration |

Pour une modification de réglage, suivre le
[contrat de configuration](../configuration.md). Les outils `config_list`,
`config_get`, `config_validate` et `config_patch` sont à utiliser lorsqu'ils
sont exposés. Une écriture requiert l'ETag courant ; une proposition sensible
reste en attente jusqu'à la décision utilisateur prévue. Les secrets restent
hors des documents et des comptes rendus.

[Retour à l'index agents](README.md)
