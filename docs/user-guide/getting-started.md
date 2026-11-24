# Premiers pas avec Macro

Cet exercice crée un système AgSDL dans Architect. Il prend une courte note et en tire trois actions. Vous enregistrerez une première version, puis vous pourrez la consulter ou en tirer un autre blueprint.

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
Une connexion réussie avec zéro modèle ne suffit pas pour échanger avec l’agent de conception.
Consultez **Modèles d'IA** si le catalogue nécessite un réglage.

Saisissez les clés dans les réglages du fournisseur. Elles n'ont pas leur place
dans un message à l'agent ni dans un fichier du projet.

## 2. Créer le système dans Architect

Dans **Architect**, ouvrez la **Bibliothèque de blueprints**. Cliquez sur **Nouveau projet** et donnez-lui un nom, par exemple « Réunions ». Ce projet range vos systèmes dans Macro. Sélectionnez-le, cliquez sur **Nouveau blueprint** et nommez le brouillon « Actions de réunion ».

Décrivez le résultat souhaité dans la conversation du nouveau système. Par exemple :

> Crée un système AgSDL avec un seul agent. Il reçoit une note de réunion et en extrait jusqu’à trois actions. Si personne n’est nommé pour une action, il écrit « responsable à préciser ».

Le panneau droit affiche le graphe du système sélectionné. Cliquez sur l’agent pour vérifier ses instructions. Demandez une correction dans la même conversation si nécessaire.

## 3. Enregistrer et retrouver la première version

Cliquez sur **Enregistrer une version**. Vous pouvez ajouter une note, par exemple « Trois actions avec responsable », pour la reconnaître plus tard. Ouvrez **Version 1** dans la liste **Versions** et vérifiez les instructions de l’agent.

Choisissez **Retour au brouillon** pour poursuivre la conception. Les modifications suivantes touchent le brouillon. Après avoir rouvert Macro, vous pouvez retrouver la première définition dans **Versions**. Pour essayer une autre conception dans un blueprint distinct, ouvrez la version souhaitée puis choisissez **Adapter cette version**.

Si deux fenêtres modifient le même brouillon, Architect affiche le numéro de la révision que vous avez ouverte et celui de la dernière révision enregistrée. Reprendre le brouillon enregistré abandonne les modifications de votre fenêtre. Réappliquer vos modifications remplace le brouillon enregistré en entier, annexes comprises.

[Sommaire du guide](README.md) · [Protocole de vérification pour les agents](../agents/getting-started.md)
