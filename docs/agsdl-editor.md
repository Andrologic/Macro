# Éditeur AgSDL dans Architect

Cette première version permet de créer, modifier et exporter un processus
AgSDL 0.1.0 depuis un plan en brouillon. Le chat reste au centre ; l’éditeur
occupe le panneau droit, avec une vue étendue et les panneaux repliables du shell.
L’onglet **Stratégie existante** conserve le fonctionnement actuel des plans.

## Essayer le parcours

1. Lancer Macro depuis le worktree avec `bun install`, puis `bun run tauri:dev`.
2. En mode Architect, créer ou ouvrir un plan en brouillon. Dans le panneau droit,
   choisir **AgSDL**, puis l’exemple Release, Feature, Hotfix ou Bugfix.
3. Dans **Processus**, sélectionner un appel d’agent : inspecter ses propriétés,
   ouvrir son agent et modifier ses instructions. Les sorties se relient par
   glisser-déposer ou par les listes de destinations de l’inspecteur.
4. Dans **Système**, inspecter un agent et ses connexions, ou choisir toutes les
   déclarations dans la liste. Ajouter un
   agent, un outil ou un contenu réutilisable. Les propriétés complètes restent
   accessibles en JSON. Les ajouts incomplets apparaissent dans les diagnostics.
5. Dans **Configuration**, inspecter les liaisons des agents. Les moteurs des
   exemples valent explicitement `null`. Choisir une configuration dans la liste
   ne la sélectionne pas dans le document : le bouton dédié le fait explicitement.
6. Appliquer les champs modifiés, enregistrer, puis recharger. Exporter le JSON
   et le réimporter dans un autre plan. Les dépendances déclarées peuvent recevoir
   des annexes locales depuis **Source** ; chaque annexe s’exporte séparément.
7. Dans le chat du plan, demander par exemple : « Dans le document AgSDL,
   précise les preuves attendues de l’agent qui vérifie les installateurs. »
   L’IA lit la révision avec `agsdl_get`, puis modifie le document avec
   `agsdl_update`. La modification apparaît dans le panneau et est enregistrée.

Les champs JSON et les instructions ont un bouton **Appliquer**. Leurs saisies
restent en mémoire pendant un changement d’onglet, de plan ou de taille du panneau.
L’enregistrement et les mutations de l’IA attendent qu’elles soient appliquées
ou abandonnées. Les modifications appliquées disposent d’un historique
Annuler/Rétablir en mémoire. Une révision obsolète est refusée à l’enregistrement ;
le brouillon local reste disponible pour export et récupération.
Un plan contenant uniquement un document AgSDL est conservé comme brouillon
édité, y compris lors de la consolidation des plans vides. Le chargement natif
conserve sa source et ses annexes.

## Portée de cette version

Les exemples illustrent des processus modifiables. Ils ne remplacent pas encore
les formulaires GitFlow ni la stratégie exécutée dans Implement. Cette version
ne lance aucun système AgSDL et ne fournit pas encore de catalogue de blueprints
personnels. La disposition automatique et les déplacements des cartes sont des
états de vue ; les positions ne sont pas exportées dans AgSDL.

Les diagnostics distinguent les déclarations D, les graphes G et les
configurations R. Leur réussite porte sur ces vérifications, pas sur la capacité
à exécuter le système. G 0.1.0 décrit des graphes séquentiels fermés ; les boucles,
le parallélisme et les sous-graphes ne sont pas ajoutés par l’éditeur. Les annexes
ne sont pas téléchargées et leur ajout ne réécrit pas les statuts ou empreintes
déclarés dans le document. Les éditions inconnues restent accessibles en source
et exportables, avec l’édition structurée désactivée.

Le document et ses annexes sont limités ensemble à 1 Mio. La source originale est
conservée, y compris les champs opaques, les nombres JSON et les espaces. Une
modification ciblée remplace sa valeur ; l’ajout ou la suppression d’un membre
réécrit son parent avec le sérialiseur sans perte des nombres. Les clés JSON
dupliquées sont refusées par l’édition structurée. Une source incomplète peut
rester enregistrée comme brouillon et être réparée dans la vue Source.

## Vérifications du lecteur

Le lecteur intégré provient du tag AgSDL `v0.1.0`. Sa provenance, sa licence et
ses adaptations navigateur sont documentées dans
[`src/vendor/agsdl/NOTICE.md`](../src/vendor/agsdl/NOTICE.md).
Les tests ciblés se trouvent dans `src/services/agsdl/`, dans le test du service
de plans et dans `src/components/agsdl/AgsdlFieldEditor.test.tsx`.

Pour comparer les rapports complets et les octets échangés avec un checkout du
tag de référence :

```sh
bun dev/agsdl/check-reader-parity.mjs <checkout-AgSDL-v0.1.0>
```

Cette comparaison couvre les 107 cas applicables du corpus officiel. Seule
l’identité du processeur est différente : Macro déclare son adaptation navigateur.
