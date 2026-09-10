# Visualisateur AgSDL dans Architect

Le panneau droit présente le système AgSDL sur un canvas non éditable. La conversation
reste au centre et l’agent modifie le document avec `agsdl_get` et `agsdl_update`.
Les formulaires JSON, les poignées de connexion et l’ancienne vue de stratégie
ont été retirés. Les exemples restent accessibles à l’agent pour initialiser
un document vide. Le panneau n’affiche pas d’aide permanente ni de statut lorsque
le document est enregistré. Les alertes de validation et les modifications en
attente restent visibles ; les détails du système se consultent à la demande.

## Essayer le parcours

1. Ouvrir un plan dans Architect. Les anciennes stratégies sont converties lors
   du premier chargement du panneau, sans changer le statut du plan.
2. Lire les participants et leurs relations sur le canvas. Les interfaces du
   système et les fins techniques ne sont pas des étapes affichées. Le bouton
   « Détails du système » dans l’en-tête ouvre ses interfaces déclarées, son point
   de départ et ses ressources ; sa configuration reste dans les détails techniques.
   Les interfaces, outils et ressources se consultent dans les détails du
   composant. Sélectionner une flèche pour consulter la relation et les données
   explicitement transmises. Aucun transfert n’est déduit du seul ordre des étapes.
3. Sélectionner un nœud pour ouvrir sa mission, ses outils et ses échanges dans
   une modale, sans réduire le canvas. La modale affiche la mission complète ; les données partagées et les échanges non adjacents
   y indiquent leur provenance. Les types, outils et ressources restent repliés.
   Une approbation indique l’action à valider et l’approbateur prévu. Aucun bouton
   de validation n’exécute cette étape : il s’agit du visualisateur du processus.
   La croix, le fond de la modale et la touche Échap referment les détails. Dans
   un plan en brouillon, le bouton de modification ouvre le nom et les instructions
   avec Enregistrer et Annuler. Les sections repliées donnent accès aux outils,
   ressources et contrats pris en charge. Les références se choisissent parmi les
   déclarations existantes ; un contrat déjà consommé reste en lecture seule.
   « Toutes les déclarations » donne aussi accès aux définitions inutilisées.
   Les instructions conservent leur propriétaire AgSDL,
   y compris lorsqu’elles sont partagées. Une saisie non enregistrée est confirmée
   avant fermeture. Un conflit de version conserve la saisie ; un échec de sauvegarde
   conserve le document modifié et propose de réessayer. Les chemins
   techniques de succès, d’échec et de refus restent consultables dans les détails.
   Les références absentes ou ambiguës ne créent pas de faux échanges.
4. Utiliser le bouton d’élargissement pour ouvrir le graphe dans une grande
   modale. La croix, la touche Échap ou un clic sur le fond ferment cette vue.
   Les panneaux conservent leur disposition. Le graphe peut être déplacé, zoomé
   et recadré. Ces gestes ne modifient pas la source AgSDL.
5. Dans un plan en brouillon, demander à l’agent de créer un exemple Release ou
   de modifier la mission d’un agent. Le document enregistré apparaît dans le
   visualisateur. Depuis les détails d’un composant, d’une relation ou d’un problème
   localisé, joindre une référence au chat pour préciser la demande. Cette action
   revient au chat, préserve le brouillon et n’envoie aucun message. La sélection
   peut être retirée ; si la source change, il faut la joindre à nouveau. Les
   métadonnées techniques accompagnent la requête sans apparaître dans le texte
   du message. Les erreurs de sauvegarde restent visibles.
6. Utiliser Annuler ou Rétablir dans l’en-tête pour parcourir les modifications
   de la session. Le document restauré est enregistré dans le plan. Ces commandes
   sont désactivées pendant une sauvegarde et hors du statut brouillon.
7. Ouvrir les diagnostics depuis les détails du système. Lorsqu’un problème
   désigne un composant identifiable, le retrouver ou le joindre au chat pour
   correction. Un problème sans emplacement fiable reste global. Les contrôles
   vérifient le document ; ils ne garantissent pas son exécution.

## Conversion des plans existants

La conversion ajoute un document AgSDL 0.1.0 descriptif, avec des agents et leurs
instructions. Une ressource réservée conserve intégralement les nœuds, les todos,
les contrats d’artefacts et les branches prédictives. Les dépendances héritées
sont affichées comme telles : elles ne prouvent pas un transfert de données.
Aucun graphe séquentiel n’est inventé pour remplacer des dépendances arbitraires.
L’agent peut ensuite préciser les interfaces et construire le processus AgSDL.

La migration est idempotente et utilise la file de mutations et le journal de
réplication des métadonnées. Elle conserve les statuts, dates de modification,
transcripts et documents AgSDL déjà présents. Les plans archivés peuvent aussi
être convertis. Une réplication incomplète ou une conversion dépassant 1 Mio
bloque l’écriture sans supprimer le plan original.

L’interface et les outils de rédaction de stratégie legacy sont retirés du
parcours Architect. Les données d’exécution historiques restent présentes pour
les tâches Implement déjà créées. Leur suppression complète dépend d’un
adaptateur d’exécution AgSDL ; cette version ne l’introduit pas. Le document
converti est un instantané descriptif, pas un moteur d’exécution ni un suivi en
direct des tâches historiques.

## Contrat et conservation

La source et les annexes restent dans les métadonnées du plan. Les modifications
par l’agent contrôlent la conversation propriétaire, le statut brouillon et la
révision. Les valeurs opaques et les jetons numériques sont conservés par le
sérialiseur sans perte. Les diagnostics structurels ne certifient pas la capacité
à exécuter le système.

Le lecteur de référence provient du tag AgSDL `v0.1.0`. Sa provenance, sa licence
et ses adaptations sont décrites dans
[`src/vendor/agsdl/NOTICE.md`](../src/vendor/agsdl/NOTICE.md).

```sh
bun dev/agsdl/check-reader-parity.mjs <checkout-AgSDL-v0.1.0>
```
