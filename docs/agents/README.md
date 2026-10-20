# Documentation pour les agents

Cette documentation s'adresse aux agents qui travaillent dans Macro, ainsi
qu'aux agents qui doivent expliquer ou vérifier son fonctionnement. Elle décrit
les préconditions, les responsabilités et les preuves attendues.

Pour exécuter une première modification, lire la
[prise en main agents](getting-started.md). Pour accompagner une personne dans
l'interface, utiliser le [guide utilisateur](../user-guide/getting-started.md).

## Charger le contexte utile

| Travail demandé | Référence à consulter |
| --- | --- |
| Réaliser une tâche autonome et rendre un résultat vérifiable | [Prise en main agents](getting-started.md) |
| Modifier le code de Macro | [Instructions du dépôt](../../AGENTS.md), puis [contribution](../../CONTRIBUTING.md) |
| Modifier Architect, Implement, Chat, Git ou les métadonnées | [Spécification fonctionnelle](../functional-spec.md) et [architecture technique](../technical-architecture.md) |
| Diagnostiquer le démarrage, la reprise ou la finalisation d'une tâche | [Workflows des tâches et des plans](../task-plan-workflows.md) |
| Lire ou modifier la configuration | [Contrat de configuration](../configuration.md), notamment l'accès des agents |
| Adapter les résultats d'outils MCP | [Résultats des outils MCP](../mcp-tool-results.md) |
| Choisir les validations d'un changement | [Stratégie de test](../test-strategy.md) et scripts de [développement](../../DEVELOPMENT.md) |
| Préparer ou publier une version | [Runbook de release](../release-agent-runbook.md) |
| Examiner un contrat interne Pilot | [Index des contrats Pilot](../../contracts/macro-pilot/README.md) |

Les contrats internes et les capacités expérimentales documentées ne prouvent
pas leur disponibilité dans une version distribuée. Vérifier le périmètre dans
le [support](../../SUPPORT.md), les [notes de version](../../CHANGELOG.md) et le
code concerné. Les limites de validation des nouveaux guides sont indiquées dans
le [sommaire](../README.md#entretenir-les-guides).

## Résoudre un écart documentaire

Pour décrire un comportement actuel, confronter la documentation au code, aux
schémas exposés et à l'état observé du runtime. Pour comprendre une intention
produit, lire la spécification et la roadmap. Si la cible et le comportement
actuel diffèrent, expliciter l'écart dans le résultat.

Les instructions du dépôt gouvernent les contributions à Macro. Cette référence
complète ces instructions avec du contexte à charger selon le travail ; elle
ne remplace ni les permissions du runtime ni les décisions de l'utilisateur.

[Retour au sommaire](../README.md)
