# Premiers pas avec Macro

Ce guide vous accompagne jusqu'à une première modification relue, enregistrée
dans Git et intégrée localement. L'exemple ajoute un court fichier de
documentation dans un dépôt d'essai.

Il concerne l'application desktop locale, avec les libellés français. La
[version de référence et les limites de vérification](../README.md#entretenir-les-guides)
sont indiquées dans le sommaire.

## Avant de commencer

Préparez :

- Macro installé. Suivez les [instructions d'installation](../../INSTALL.md)
  si nécessaire.
- Un fournisseur d'IA utilisable dans Macro et un modèle capable d'utiliser
  des outils. Vous pouvez le configurer à l'étape suivante.
- Un petit dépôt Git local avec au moins un commit, sans modification en attente.
  Utilisez un dépôt d'essai pour découvrir le parcours.
- Git disponible sur votre machine, avec votre nom et votre adresse de commit
  configurés.

Vous n'avez pas besoin de compiler Macro pour suivre ce guide.

## 1. Vérifier la connexion à l'IA

Ouvrez les **Paramètres** avec l'icône d'engrenage, puis **Fournisseurs d'IA**.
Si un fournisseur est déjà prêt et ses modèles sont disponibles, vous pouvez
le conserver.

Pour ajouter une connexion avec une clé API :

1. Cliquez sur **Ajouter un provider**.
2. Choisissez le type correspondant à votre fournisseur.
3. Renseignez son nom, l'URL demandée et sa clé API si elle est nécessaire.
4. Cliquez sur **Enregistrer le provider**, puis **Tester la connexion**.

Certaines connexions proposées utilisent une authentification dans le navigateur.
Dans ce cas, suivez le bouton de connexion de la fiche du fournisseur.

Le résultat attendu est une connexion utilisable et au moins un modèle disponible.
Une connexion réussie avec zéro modèle ne suffit pas pour démarrer une tâche.
Consultez **Modèles d'IA** si le catalogue nécessite un réglage.

Saisissez les clés dans les réglages du fournisseur. Elles n'ont pas leur place
dans un message à l'agent ni dans un fichier du projet.

## 2. Ajouter le dépôt d'essai

1. Dans Architect ou Implement, utilisez **Ajouter un projet**. Si des projets
   sont déjà présents, ouvrez le gestionnaire de projets pour ajouter le vôtre.
2. Choisissez **Projet existant** comme source.
3. Sélectionnez le dossier du dépôt, puis **Pas de groupe** pour cet exercice.
4. Cliquez sur **Ajouter le projet existant**.
5. Si Macro propose une configuration Git, lisez les branches détectées et les
   actions proposées avant de les confirmer. Gardez les conventions de votre dépôt.

Le projet doit apparaître dans Macro et permettre le travail modifiable. Un
projet en lecture seule peut servir de contexte, mais ne permet pas le parcours
avec branche et worktree utilisé ici.

## 3. Créer une tâche autonome

Pour cette petite modification, vous pouvez démarrer directement dans Implement.
Un plan Architect sera utile pour un travail comportant plusieurs tâches.

1. Passez dans **Implement**.
2. Dans le panneau **Tâches**, cliquez sur le bouton `+`, dont l'infobulle est
   **Créer une tâche autonome**.
3. Choisissez votre dépôt comme **Projet cible**.
4. Sélectionnez le type **Feature** et le point de départ **Nouveau travail**.
5. Cliquez sur **Créer la tâche**.

Macro ouvre une conversation de tâche en brouillon. Le premier message lancera
la préparation du travail. Le type Feature utilisera une branche et un worktree
dédiés ; le type Direct travaille dans le dossier du projet et suit un autre
parcours.

## 4. Donner une consigne limitée

Dans les contrôles de la conversation, vérifiez le fournisseur et le modèle
choisis. Envoyez ensuite cette consigne :

```text
Ajoute un fichier macro-quickstart.md à la racine de ce dépôt d'essai.
Il doit contenir le titre « Prise en main de Macro » et une phrase indiquant
que ce fichier sert à tester le parcours de modification et de revue.
Si ce fichier existe déjà, demande-moi un autre nom avant de le modifier.
Modifie uniquement ce fichier. Arrête-toi après la modification pour me
laisser relire le résultat et utiliser les actions de validation de Macro.
Laisse-moi créer le commit et terminer la tâche depuis l'interface.
```

Macro prépare l'espace de travail puis démarre l'agent. Attendez la fin du tour.
Si l'agent pose une question ou demande une approbation, lisez la demande et
répondez dans la tâche avant de poursuivre.

Le résultat attendu est un seul fichier ajouté dans le worktree de la tâche,
visible dans le panneau **Changements**. La réponse de l'agent vous aide à
comprendre ce qu'il a fait ; vérifiez aussi le fichier lui-même.

## 5. Relire et valider le fichier

1. Dans **Changements**, ouvrez `macro-quickstart.md` pour lire son diff.
2. Vérifiez le titre, la phrase et l'absence d'autres modifications.
3. Si le résultat vous convient, utilisez **Valider** pour le fichier ou
   **Valider les changements** après avoir ouvert tous les diffs en attente.

Pour ce fichier de texte, la lecture du contenu suffit. Pour une modification
applicative, demandez aussi les tests ou l'essai adaptés avant de valider.

Si le contenu doit changer, demandez une correction dans la même conversation,
puis relisez le nouveau diff. La validation doit porter sur le résultat final.

## 6. Créer le commit et terminer la tâche

Cliquez sur **Commit** après la validation. Lors du premier usage, Macro peut
vous demander quel modèle utiliser pour préparer le message de commit.
Suivez les choix proposés ; si la génération du message échoue, utilisez la
saisie manuelle proposée par l'interface.

Une fois le commit créé, cliquez sur **Terminer la tâche**. Macro vérifie le
flux de fusion vers la branche d'intégration. Pour une Feature autonome, il
s'agit de la branche de développement configurée pour ce projet.

Si une revue de fusion ou un blocage apparaît, suivez l'action indiquée et
reprenez la fin de tâche après résolution. Un commit créé ne garantit pas à lui
seul que l'intégration est terminée.

Vous avez terminé lorsque :

- la tâche est indiquée comme terminée ;
- le fichier est présent sur la branche d'intégration du dépôt ;
- le contenu correspond au diff que vous avez relu.

Ce parcours aboutit à une intégration locale. Une publication sur un dépôt
distant reste une action Git distincte.

## Si vous êtes bloqué

| Ce que vous constatez | Ce qu'il faut vérifier |
| --- | --- |
| Aucun modèle sélectionnable | Le fournisseur est connecté et son catalogue contient un modèle utilisable |
| Le dépôt n'apparaît pas dans la création de tâche | Le projet est modifiable et le filtre de recherche ne le masque pas |
| La préparation échoue | Lisez l'erreur de branche, de worktree ou de commande de setup avant de réessayer |
| L'agent attend une réponse | Ouvrez la conversation et traitez la question ou l'approbation affichée |
| La validation est grisée | Ouvrez chaque diff en attente et attendez la fin du tour ou de l'approbation |
| Le commit ne peut pas être créé | Vérifiez la validation des fichiers, l'identité Git et le message d'erreur |
| Le commit existe, mais la tâche reste ouverte | Utilisez Terminer la tâche et traitez les éventuels blocages de fusion |

Pour signaler un problème, suivez le [guide de support](../../SUPPORT.md).
Indiquez la version de Macro, votre système, l'étape concernée et le message
d'erreur, après avoir retiré les clés et les données privées.

## Après ce premier essai

Pour un changement plus large, ouvrez Architect, créez un plan et discutez du
besoin. Demandez explicitement la génération de la stratégie, relisez-la puis
validez-la avant de lancer ses tâches dans Implement.

[Retour au guide utilisateur](README.md) · [Version détaillée pour les agents](../agents/getting-started.md)
