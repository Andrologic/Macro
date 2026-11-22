# Premiers pas avec Macro

Cet exercice crée un système AgSDL dans Architect. Il prend une courte note et en tire trois actions. Vous pourrez rouvrir sa définition et, si votre installation prend en charge son exécution, suivre le travail dans Operate.

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

Dans **Architect**, sélectionnez un projet d’essai où vous pouvez enregistrer un document. Pour ajouter un projet existant, utilisez **Ajouter un projet** et choisissez son dossier. Dans le navigateur de gauche, ouvrez le menu de création du projet puis choisissez **Créer un système**.

Décrivez le résultat souhaité dans la conversation du nouveau système. Par exemple :

> Crée un système AgSDL avec un seul agent. Il reçoit une note de réunion et en extrait jusqu’à trois actions. Si personne n’est nommé pour une action, il écrit « responsable à préciser ».

Le panneau droit affiche le graphe du système sélectionné. Cliquez sur l’agent pour vérifier ses instructions. Demandez une correction dans la même conversation si nécessaire. Utilisez **Enregistrer et exporter** pour conserver le document dans le projet. Rouvrez Macro puis sélectionnez votre système dans le navigateur du projet pour retrouver sa définition.

## 3. Lancer et suivre une exécution

Pour un système AgSDL 0.3 compatible, **Lancer** se trouve dans le panneau droit d’Architect. Utilisez une note fictive comme entrée si le formulaire en demande une. Si le lancement est refusé, le diagnostic indique la condition à remplir sur cette machine. [Profils d’exécution pris en charge](../agsdl-codex-native.md)

Passez dans **Operate** après le lancement. Sélectionnez l’exécution pour ouvrir son graphe ou une instance d’agent pour lire ses échanges disponibles. Si une demande de réponse apparaît, sa notification ouvre l’exécution concernée. Deux lancements du même système ont chacun leur propre historique.

[Sommaire du guide](README.md) · [Protocole de vérification pour les agents](../agents/getting-started.md)
