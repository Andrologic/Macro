# Review d’un artefact logiciel AgSDL

Le parcours logiciel utilise un workspace explicitement sélectionné, le profil
natif isolé de Codex pour l’auteur et le profil Claude contrôlé pour la review.
Son objet de review est une chaîne de patch retenue dans le journal. Cette chaîne
ne désigne pas une révision Git ni une photographie du disque.

## Contrat du parcours

1. L’auteur modifie le projet sélectionné et exécute un contrôle local borné dans
   son profil Codex capturé. Sa fin physique précède son terminal AgSDL.
2. Un Call `git_diff` demande `mode="patch"`, `require_complete=true`,
   `ignore_whitespace=false`, une base Git immuable, les chemins sélectionnés et
   un nombre de lignes de contexte explicite.
3. Prepare sélectionne `data` dans le résultat du Call et le transmet comme
   ressource inline `text/plain`. La chaîne retenue fait foi, y compris ses
   accents et fins de ligne. Une URI ou une lecture ultérieure de `HEAD` ne la
   remplace pas.
4. Le reviewer Claude reçoit cette ressource avec la seule publication AgSDL.
   Il publie une review structurée validée par le contrat de sortie capturé.

Un échec de capture produit un échec du Call. Il ne fournit pas de patch à la
route normale du reviewer. Une réponse native incertaine reste incertaine,
sans nouvel appel destiné à reconstruire un résultat supposé identique.

## Limites à conserver

Le patch sélectionné ne couvre pas les fichiers ignorés ou hors sélection,
les régions hors hunks ni tous les états intermédiaires de l’index. Une
suppression et un ajout ne garantissent pas la détection d’un renommage.
`stat` et `name_only` sont des résumés. La fidélité du patch strict concerne le
renderer libgit2 natif ; elle ne qualifie pas les transports WSL ou Windows.
Voir [la qualification du renderer](agsdl-qualification.md#artefact-de-patch-texte-natif).

Modifier le fichier vivant après capture ne modifie pas l’artefact retenu.
Cela ne garantit pas la stabilité du workspace, la couverture de toutes ses
modifications ni la pertinence d’une intégration ultérieure. La qualification
bornée utilise un projet synthétique initialement propre et contrôle elle-même
les chemins, les non suivis et l’absence de modifications concurrentes. Ces
préconditions du test ne constituent pas de nouveaux gardes du produit.

Aucun staging, commit, merge, création automatique de worktree ou stockage
parallèle d’artefacts n’est ajouté au système. Les commandes shell de l’auteur
appartiennent au profil natif Codex ; elles ne deviennent pas des outils Macro
qualifiés pour Claude.

## Vérifications reproductibles

`softwareReview.test.ts` compile une déclaration Call/Prepare réelle avec des
ports contrôlés. Il vérifie les options strictes, la conservation de la chaîne
jusqu’à l’entrée de l’adaptateur Claude, puis les échecs de capture et de reçu.
Il complète les tests du renderer et ceux des frontières physiques des deux
adaptateurs. Il ne prétend pas exécuter SQLite, Git ou les fournisseurs réels.

Les preuves natives d’une qualification doivent comparer la sortie retenue du
Call, la sortie de Prepare et l’entrée retenue du reviewer, puis vérifier dans
SQLite l’ordre fin de l’auteur, capture, publication et terminal du reviewer.
Les preuves locales restent hors du dépôt public et séparent les essais réels,
les pannes simulées et les garanties réutilisées des adaptateurs.
