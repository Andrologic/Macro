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
   « Détails du système » présente son objectif et les informations à compléter.
   Les diagnostics et contrats techniques sont joints au chat pour être analysés par le modèle.
   Sélectionner une flèche pour consulter la relation et les données
   explicitement transmises. Aucun transfert n’est déduit du seul ordre des étapes.
3. Sélectionner un agent pour ouvrir une fiche compartimentée, sans réduire le
   canvas : prompt complet, entrées avec provenance, sorties prévues avec leurs
   destinataires, puis outils et connexions. Survoler ou focaliser un agent lié
   pour prévisualiser sa mission ; cliquer ouvre sa fiche. Échap ferme d’abord
   l’aperçu, puis la fiche. Les données d’entrée du système et son résultat final
   ne sont pas présentés comme des tâches. Les paramètres du moteur et des
   implémentations d’outils se consultent dans leur configuration repliée, y
   compris les paramètres MCP lorsqu’ils sont déclarés. Aucun accès n’est déduit
   des fournisseurs ou serveurs globaux de Macro.
   Une approbation indique l’action à valider et l’approbateur prévu. Aucun bouton
   de validation n’exécute cette étape : il s’agit du visualisateur du processus.
   La croix, le fond de la modale et la touche Échap referment les détails. Dans
   un plan en brouillon, le bouton de modification ouvre le nom et les instructions
   avec Enregistrer et Annuler. Les sections repliées donnent accès aux outils et
   ressources modifiables parmi les déclarations existantes. Les contrats et la
   création de nouvelles déclarations se modifient par le chat.
   Les instructions conservent leur propriétaire AgSDL,
   y compris lorsqu’elles sont partagées. Une saisie non enregistrée est confirmée
   avant fermeture. Un conflit de version conserve la saisie ; un échec de sauvegarde
   conserve le document modifié et propose de réessayer.
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
6. Ouvrir la revue de la dernière modification pour comparer les valeurs et,
   si nécessaire, annuler ce changement. Le document restauré est enregistré
   dans le plan. Cette action est désactivée pendant une sauvegarde et hors brouillon.
7. Cliquer sur le signal de problème dans l’en-tête pour joindre directement
   les diagnostics au chat. Une pastille compacte dans la saisie indique le
   système à examiner ; son survol précise qu’aucun message n’a été envoyé. Lorsqu’un problème
   désigne un composant identifiable, le retrouver ou le joindre au chat pour
   correction. Un problème sans emplacement fiable reste global. Les contrôles
   vérifient le document ; ils ne garantissent pas son exécution.

## Concevoir et réutiliser un système

Un plan conserve pour l’instant une conversation de conception et un document
AgSDL. Depuis un plan vide, le panneau propose de commencer un système vide,
d’utiliser un blueprint inclus ou enregistré, ou d’adapter un système existant.
La bibliothèque lit les plans accessibles dans les métadonnées Macro. Une erreur
de lecture reste visible avec une action de reprise ; les sources lisibles et les
exemples inclus restent disponibles. Sélectionner une source affiche son objectif
et ses composants principaux avant de créer une copie.

La fiche de conception sépare l’objectif, le contexte partagé, les règles du
processus et les informations à fournir pour adapter le système au projet.
Un brouillon peut rester incomplet. Les champs sans valeur restent à compléter ;
la valeur du projet est directement accessible. Les définitions de champs et
les règles se modifient par le chat. « Enregistrer et ouvrir le chat » joint le
système enregistré sans envoyer de message. Après une copie contenant des informations manquantes, cette fiche
s’ouvre. Les agents sans instructions portent un indicateur discret. Ces informations
sont des consignes de conception : l’agent doit les traduire explicitement dans
les instructions, ressources, contrats ou étapes du graphe. Une règle décrite
n’est pas une garantie d’exécution.

Enregistrer un blueprint crée atomiquement un autre plan contenant une copie du
document et de ses annexes, avec le nom choisi. Le plan courant reste actif.
La copie conserve le contexte et la configuration déclarés ; l’utilisateur peut
les adapter avant d’enregistrer le modèle. Partir de cette copie initialise un
plan vide et conserve la provenance et la révision du modèle. Les modifications
ultérieures restent indépendantes. Les blueprints ne sont pas synchronisés
automatiquement avec leurs adaptations.

Le canvas propose les vues Vue d’ensemble et Échanges. La seconde montre uniquement
les transmissions effectivement déclarées entre les composants visibles. Les
informations d’entrée communes et les résultats terminaux restent dans les
fiches. Le survol et le focus soulignent les voisins concernés. Des groupes
nommés explicitement par l’agent peuvent être repliés ; ces groupes ne sont pas
des étapes d’exécution. Une édition d’instructions conserve le cadrage.

Après une modification, une action permet d’examiner les derniers changements
de la session : composants ajoutés, modifiés ou retirés, valeurs avant et après
pour le nom et les instructions, et signalement des connexions et configurations
modifiées sans exposer leur structure technique. Les détails restent repliés.
Les changements de modèle concernent les appels de l’agent
configuré. La revue signale aussi les informations de conception modifiées.
Les changements limités à la mise en forme n’affichent pas de revue vide. Les modifications locales
et celles de l’IA suivent le même historique Annuler/Rétablir. Fermer cet aperçu
ou masquer ses repères ne change pas le document. Cet historique ne constitue
pas un historique durable de toutes les versions du système.

La modale d’édition d’un agent permet de choisir un fournisseur et un modèle
configurés dans Macro lorsqu’une configuration AgSDL unique peut être identifiée.
Le moteur déclaré est Macro. En 0.2.0, la configuration référence un binding
`macro/agent-engine` en version `1`, implémenté par `macro/desktop` en version `1`.
Le lecteur historique conserve ses règles d’édition, dont la conversion de l’alias
`macro` en `macro/desktop` lors de la sauvegarde d’une configuration 0.1.0. Les configurations importées étrangères ou ambiguës restent
préservées et doivent être préparées par l’agent avant cette édition. Les outils
et MCP restent des déclarations indépendantes du choix du modèle. Ces déclarations
ne confèrent aucune autorisation d’exécution.
Cette version ne lance pas les systèmes AgSDL et n’ajoute pas de mode orchestrateur.

## Conversion des plans existants

La conversion des nouveaux imports de plans ajoute un document AgSDL 0.2.0
descriptif, avec des agents et leurs instructions. L’enveloppe Macro conserve
les données originales et les limites de conversion. Les documents 0.1.0 déjà
présents gardent leur édition. Les données conservées comprennent les nœuds, les todos,
les contrats d’artefacts et les branches prédictives. Les dépendances héritées
restent dans l’enveloppe de migration ; elles ne prouvent pas un transfert de données.
Aucun graphe séquentiel n’est inventé pour remplacer des dépendances arbitraires.
L’agent peut ensuite préciser les interfaces et construire le processus AgSDL.

La migration est idempotente et utilise la file de mutations et le journal de
réplication des métadonnées. Elle conserve les statuts, dates de modification,
transcriptions et documents AgSDL déjà présents. Les plans archivés peuvent aussi
être convertis. Une réplication incomplète ou une conversion dépassant 1 Mio
bloque l’écriture sans supprimer le plan original.

L’interface et les outils de rédaction de stratégie legacy sont retirés du
parcours Architect. Les données d’exécution historiques restent présentes pour
les tâches Implement déjà créées. Leur suppression complète dépend du démarrage
AgSDL depuis le produit, encore fermé tant qu’il n’est pas qualifié. Le document
converti reste un instantané descriptif. Le visualisateur peut toutefois afficher
les états actuels des tâches Macro liées, indépendamment de cet instantané.

## Contrat et conservation

La source et les annexes restent dans les métadonnées du plan. Les modifications
par l’agent contrôlent la conversation propriétaire, le statut brouillon et la
révision. Les valeurs opaques et les jetons numériques sont conservés par le
sérialiseur sans perte. Les diagnostics structurels ne certifient pas la capacité
à exécuter le système.

Les nouveaux documents utilisent AgSDL `v0.2.0`. Le lecteur `v0.1.0` reste
disponible pour les sources historiques. Le [contrat 0.2.0](agsdl-020.md) décrit
les nouvelles déclarations et les limites de cette adaptation. La provenance,
la licence et les adaptations des lecteurs sont décrites dans
[`src/vendor/agsdl/NOTICE.md`](../src/vendor/agsdl/NOTICE.md).

```sh
bun dev/agsdl/check-reader-parity.mjs <checkout-AgSDL-v0.1.0>
```

## Indicateurs de tâches dans le graphe

Les blocs liés à une tâche reprennent les indicateurs partagés de Macro et ses
états réels, y compris l’activité de la conversation et les blocages. Aucun
statut n’est déduit du titre du bloc ou du statut enregistré dans la migration.

Pour les cartes legacy, le lien utilise l’identifiant original du nœud. Pour
un document natif, `macroTaskId` doit référencer l’identifiant exact de la tâche
dans `agsdl.display.cards[path]` pour les documents 0.2.0.
Pour un document historique 0.1.0, le lien reste dans les annotations de la
déclaration ou dans `ControlFlow.annotations.macroSteps[stepId]` pour une étape. Le lien est limité
au même plan et à la même branche ; les tâches archivées et les liens ambigus
sont ignorés. Sans lien, le bloc conserve son icône habituelle. Un groupe replié
ne s’affiche terminé que si tous ses membres sont liés et terminés.

Ce suivi ne crée pas de tâches et ne remplace pas le moteur d’exécution Macro.
