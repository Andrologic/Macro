# Visualisateur AgSDL dans Architect

Le panneau droit présente le système AgSDL en lecture seule. La conversation
reste au centre et l’agent modifie le document avec `agsdl_get` et `agsdl_update`.
Les formulaires JSON, les poignées de connexion et l’ancienne vue de stratégie
ont été retirés. Les exemples restent accessibles à l’agent pour initialiser
un document vide.

## Essayer le parcours

1. Ouvrir un plan dans Architect. Les anciennes stratégies sont converties lors
   du premier chargement du panneau, sans changer le statut du plan.
2. Lire les entrées du processus et son point de départ. Chaque carte distingue
   les données reçues, leur provenance, les sorties et les conditions de passage.
3. Sélectionner une carte pour consulter sa mission et ses détails. Les liens
   internes permettent de rejoindre l’étape concernée. Une référence absente ou
   ambiguë est signalée sans créer de faux lien.
4. Utiliser le bouton d’élargissement pour replier le panneau gauche et donner
   plus de place au visualisateur tout en conservant le chat.
5. Dans un plan en brouillon, demander à l’agent de créer un exemple Release ou
   de modifier la mission d’un agent. Le document enregistré apparaît dans le
   visualisateur. Les erreurs de sauvegarde restent visibles.

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
