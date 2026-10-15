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

Les essais d’interruption consultent les mêmes identités de système, activation
et effet avant et après relance. Ils ne déduisent pas l’absence de rejeu du seul
texte affiché à l’écran. Les données de diagnostic locales et les captures ne
sont pas ajoutées au dépôt public.

## Couverture complémentaire et limites

| Scénario | Preuve disponible | Limite |
| --- | --- | --- |
| Admission réussie, accusé de réception perdu | Tests du store et du journal natif : reprendre conserve la clé et installe le reçu retenu. | Pas de coupure physique qualifiée dans cette fenêtre précise. |
| Stop pendant une soumission bloquée | Tests du store : Stop ne dépend pas de la soumission et vise le système exact. | Le test natif décrit plus haut couvre l’appel actif, pas une soumission artificiellement bloquée. |
| Perte du propriétaire pendant un outil ayant un effet externe | Tests natifs de récupération des effets et de non-rejeu. | Une coupure réelle pendant une écriture de fichier ou un appel MCP reste à qualifier. L’essai Macro AI sans outils ne couvre pas ce cas. |
| Anciens appels d’édition refusés avant effet | Journal QA réconcilié à partir des arguments et des refus déterministes, sans rejeu. | Les traces historiques de chat conservent leur ancien libellé ; elles ne reflètent pas la réconciliation du journal. |

Le bouton de démarrage d’une nouvelle exécution conserve son preflight sur la
source actuelle. La livraison à un Agent existant utilise sa capture et ne
requiert pas ce preflight ; le natif valide toujours la demande. Ouvrir le
panneau lit seulement les exécutions et intentions, sans soumettre ni reprendre
une demande automatiquement.
