# Qualification native AgSDL

Cette matrice décrit les essais du profil `macro-serial-inline-v1` au 15 octobre
2026. Le moteur réutilise Macro AI, les admissions natives, SQLite et le vrai
panneau d’exécution. Les essais utilisent un projet synthétique isolé. Ils ne
valent pas qualification de tous les fournisseurs ou de tous les outils.

## Disponibilité

`PRODUCT_RUNTIME_AVAILABLE` est activé. Le compilateur refuse les configurations
hors profil et le natif conserve l’autorité sur les admissions et les arrêts.
La disponibilité du produit, la validité d’un document et sa qualification en
situation de panne sont des propriétés distinctes.

## Parcours vérifiés dans l’application native

| Parcours | Résultat observé |
| --- | --- |
| Modifier des instructions, enregistrer, puis abandonner un autre brouillon | Les instructions enregistrées restent présentes. Le brouillon abandonné ne modifie pas la source. |
| Consulter une ancienne exécution après modification du document | Le prompt capturé reste celui du démarrage. La capture ne propose pas d’édition. |
| Agrandir le graphe et ouvrir les détails | Les modals s’ouvrent et se ferment ; le suivi des activations reste visible. |
| Envoyer deux messages à un Agent sans flow | Deux activations terminées ; le brouillon se vide après admission, le système attend le prochain message. |
| Fermer et relancer un système en attente | Le système existant est retrouvé, sans nouvelle activation. La livraison est disponible sans actualisation du document actuel. |
| Couper le processus pendant un appel Macro AI actif | Avant la coupure, l’activation est active et l’effet provider pending. Après relance, ils sont uncertain, avec zéro réponse finale et aucune deuxième intention d’effet. L’app bloque la livraison et demande une inspection. |
| Arrêter cette exécution interrompue | Le natif confirme la fin du processus ; l’effet devient ended et Stop est confirmé, sans inventer de réponse. |
| Demander Stop pendant une génération Macro AI active | L’app affiche Stop requested avant Stopped. Les effets sont ended lors de la confirmation. |
| Couper le processus après admission Start, avant retour du reçu | L’app retrouve la demande acceptée et propose Reprendre. La reprise acquitte la même intention et installe le même système, sans second démarrage ni activation supplémentaire. |
| Couper le processus après une écriture, avant son reçu | Après approbation, le fichier synthétique est modifié, puis le processus est coupé avant le règlement natif de l’effet. Après relance, le même effet devient uncertain, sans résultat inventé. Le contenu, le SHA-256 et la date de modification du fichier restent identiques. Stop termine l’effet sans nouvelle écriture. |
| Relire les deux anciennes traces réconciliées | Les appels apparaissent terminés au lieu de outcome unknown. La lecture applique les reçus natifs correspondant à l’identité complète, sans réécriture des messages ni rejeu. |

Les essais d’interruption consultent les mêmes identités de système, activation
et effet avant et après relance. Ils ne déduisent pas l’absence de rejeu du seul
texte affiché à l’écran. Les données de diagnostic locales et les captures ne
sont pas ajoutées au dépôt public.

## Couverture complémentaire et limites

| Scénario | Preuve disponible | Limite |
| --- | --- | --- |
| Admission réussie, accusé de réception perdu | Coupure physique qualifiée sur Start, puis reprise explicite dans l’app ; tests du store et du journal natif. | La fenêtre équivalente de Deliver reste couverte par les tests automatisés, pas par une coupure physique. |
| Stop pendant une soumission bloquée | Tests du store : Stop ne dépend pas de la soumission et vise le système exact. | Le test natif décrit plus haut couvre l’appel actif, pas une soumission artificiellement bloquée. |
| Perte du propriétaire pendant un outil ayant un effet externe | Coupure physique après écriture du fichier synthétique, avant son reçu ; tests natifs de récupération et de non-rejeu. | Cela qualifie l’adaptateur fichier Macro, pas un service MCP distant ni la coupure au milieu d’une écriture partielle. |
| Anciens appels d’édition refusés avant effet | Journal QA réconcilié à partir des arguments et des refus déterministes ; projection confirmée dans le chat. | Terminé indique un résultat connu, y compris un refus de validation, et ne signifie pas que la modification a réussi. Les appels sans reçu exact restent incertains. |

Le bouton de démarrage d’une nouvelle exécution conserve son preflight sur la
source actuelle. La livraison à un Agent existant utilise sa capture et ne
requiert pas ce preflight ; le natif valide toujours la demande. Ouvrir le
panneau lit seulement les exécutions et intentions, sans soumettre ni reprendre
une demande automatiquement.

Les fenêtres de coupure utilisent des délais bornés, disponibles uniquement avec
`debug_assertions`, la fonctionnalité `browser-runtime-debug` et un identifiant
d’application QA. La relance finale ne conserve aucun délai d’injection.

## Artefact de patch texte natif

Avec `mode="patch"` et `require_complete=true`, le renderer natif libgit2
retourne le texte UTF-8 exact des données rendues, sans troncature, ou échoue.
Il refuse les indications de différence binaire sans contenu de patch, les
lignes UTF-8 invalides et les NUL, y compris lorsque Git force le mode texte.
Les accents, CRLF, fichiers sans LF final et fichiers texte non suivis restent
pris en charge. `stat` et `name_only` restent des résumés.

Ce contrat porte sur le patch sélectionné, pas sur les régions hors hunks,
les fichiers ignorés ou hors sélection, ni sur la stabilité du workspace après
capture. Une suppression et un ajout peuvent représenter un renommage sans
que sa détection soit garantie. Pour une review fidèle, fixer
`ignore_whitespace=false`, une base immuable et les chemins et le contexte
attendus, puis transmettre la chaîne exacte retenue dans le journal, sans la
reconstruire depuis l'affichage. Un refus de capture ne fournit aucun artefact
à soumettre à la review normale.

Cette garantie concerne le chemin natif libgit2. Les transports WSL utilisent
des conversions distinctes et ne sont pas qualifiés pour cette fidélité ; les
commandes AgSDL les refusent déjà. Les tests Git du renderer ne qualifient pas
le parcours Call vers le reviewer, qui demande une vérification distincte.
