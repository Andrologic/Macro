# Validation du chantier de sécurité du 22 octobre 2026

La révision examinée est `57ca43aeaf79e66732667e564ea4af8b3410261c`, sur
`develop`. La validation locale utilise une branche `feature/*` dans un
worktree distinct, à partir de cette révision.

La validation reste incomplète : Linux et macOS réussissent, mais le job
Windows est annulé par sa limite de durée avant l'exécution des tests natifs.
Les parcours d'installation et de mise à jour d'une application installée
n'ont pas pu être essayés faute d'artefacts de test appropriés.

## Exécution GitHub Actions

[Exécution CI 39735105161](https://github.com/Andrologic/Macro/actions/runs/39735105161),
déclenchée par un push sur `develop`. Les résultats ci-dessous concernent la
tentative initiale. Aucune relance n'a été demandée pendant cette validation.

| Job | Résultat | Portée constatée dans les journaux |
| --- | --- | --- |
| [Linux validation](https://github.com/Andrologic/Macro/actions/runs/39735105161/job/119678909920) | Réussi | Ubuntu 24.04 x64, profil `native` complet. 422 fichiers de tests frontend validés ; bibliothèque Rust : 1 406 succès, deux tests ignorés. |
| [Windows native check](https://github.com/Andrologic/Macro/actions/runs/39735105161/job/119678910005) | Annulé, limite de 20 minutes | Windows Server 2025 x64. Profil `windows` réussi, puis interruption pendant la compilation du premier test natif. Aucun résultat des huit tests ciblés. |
| [macOS native recovery smoke](https://github.com/Andrologic/Macro/actions/runs/39735105161/job/119678909740) | Réussi | macOS 15 ARM64, huit invocations exécutant chacune un test, toutes réussies. |

Sur Linux, les vérifications des workflows, des versions, des frontières
d'import, des types, du lint, des traductions, du build Vite, des budgets de
bundle, du sidecar et des contrats générés passent. Les tests des autres cibles
Rust donnent respectivement 6, 8, 21 et 118 succès. Le passage de documentation
Rust réussit mais exécute zéro doctest.
Les deux tests ignorés sont
`core::workspace_execution::post_write_diagnostics::tests::real_typescript_write_error_then_edit_correction`,
qui exige un serveur TypeScript explicitement configuré, et
`project_path::tests::wsl_delayed_stdin_reader_helper`.
Les avertissements de compilation sur des attributs Serde non interprétés par
`ts-rs` et sur du code inutilisé n'ont pas fait échouer le profil.

GitHub conclut l'exécution complète avec `cancelled`. L'annotation du job
Windows indique exactement « The job has exceeded the maximum execution time
of 20m0s ». Le profil conservateur a réussi en 16 min 44 s, dont 11 min 7 s
pour le contrôle des contrats de configuration et 5 min 8 s pour
`cargo check --locked --all-targets`. L'étape des huit tests commence à
06:56:43 UTC ; Cargo compile encore le premier cas lorsque l'annulation est
enregistrée à 06:57:53 UTC. Aucun échec d'assertion n'apparaît dans le journal.

Ce dépassement n'a pas été reproduit sur Windows, aucune machine Windows
n'étant disponible dans cet environnement. Les tests macOS locaux ne
reproduisent pas les temps de compilation Windows. Lors de l'examen initial,
aucune correction du code ou du budget CI n'a été appliquée. Les journaux ne
démontrent pas de panne transitoire de runner, de service ou de réseau ; aucune
relance inchangée n'est justifiée par les éléments recueillis. La validation des huit cas sur Windows
reste à obtenir sur une future exécution du workflow corrigé ci-dessous.

Le job macOS a exécuté les huit cas de `dev/ci/native-recovery-smoke.mjs` :

- remplacement atomique du fichier d'état de l'updater ;
- conservation de l'ancien fichier quand le remplacement natif échoue ;
- application de la migration à une base SQLite existante ;
- récupération d'une restauration interrompue et conservation de l'archive de secours ;
- erreur de lecture d'un répertoire inaccessible ;
- interruption et limitation de la sortie des scripts de skills ;
- refus de création d'un projet dans un répertoire absent ;
- refus d'import d'un dépôt dans un répertoire absent.

Le script crée au besoin des exécutables de remplacement contenant
`native-test-placeholder` pour satisfaire la configuration Tauri à la compilation.
Il les supprime ensuite. Il ne construit ni ne lance un installateur. La
récupération d'une restauration de profil ne constitue pas un essai de retour
à une ancienne version de l'application.

## Contrôles locaux

La machine disponible est un Mac Apple Silicon sous macOS 27.0.1. Les contrôles
utilisent Bun 1.3.14 et Rust 1.95.0, conformément au dépôt. Les dépendances ont
été installées avec `bun install --frozen-lockfile`.

| Commande | Résultat |
| --- | --- |
| `bun dev/ci/native-recovery-smoke.mjs` | Huit tests réussis, chacun réellement exécuté. |
| `bun test dev/release/verify-updater.test.ts dev/release/updater-preflight.test.ts dev/ci/native-recovery-smoke.test.ts` | 21 tests réussis, aucune erreur. |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib app_updates:: -- --test-threads=1` | 31 tests réussis, aucune erreur. Exécutables de remplacement préparés puis supprimés, comme dans le script natif. |
| `bun run ci:workflows` | Réussi. |
| `bun run version:check` | Réussi, version 0.1.8. |
| `bun run release:updater:check` | Réussi. |

Les tests de vérification utilisent la clé publique et les signatures de test
déjà présentes dans le dépôt. Leur contenu signé est la chaîne `test`, pas un
paquet d'installation. Ils vérifient réellement les signatures avec le
vérificateur Rust et couvrent notamment le refus d'une clé étrangère, d'une
signature mal formée, d'un contenu altéré, d'une version signée absente et d'une
version signée différente du manifeste. Les fixtures Stable, nightly et RC
passent aussi par les CLI de génération et de vérification des manifestes.

Les tests `app_updates::` couvrent la revérification cryptographique avant
activation, la politique des versions mises en cache, le refus d'une
rétrogradation sans confirmation et la détection d'un manifeste remplacé
pendant la confirmation. Le choix de l'utilisateur est simulé par une fonction
de test. Aucun dialogue natif interactif n'a été exercé.

Une tentative de lancer séparément les tests internes du plugin avec
`cargo test --manifest-path src-tauri/Cargo.toml --locked -p tauri-plugin-updater --lib`
est refusée par Cargo : cette dépendance n'est pas membre du workspace et a
besoin de ses dépendances de développement. Ces tests n'ont donc pas été
exécutés. Les 31 succès ci-dessus concernent le module de Macro, et non les
tests internes du plugin.

## Essais d'installation et de mise à jour

L'API GitHub retourne zéro artefact pour cette exécution. Le workflow CI ne
prévoit aucune construction d'installateur ni aucun dépôt d'artefact. Aucun
ensemble local de paquets d'installation et de mise à jour, signé avec une clé
de test et correspondant à cette révision, n'a été identifié. Les anciens
artefacts de distribution ne remplacent pas cet ensemble de test.

| Essai demandé | macOS | Windows |
| --- | --- | --- |
| Installation de l'application | Non effectué, paquet de test absent. | Non effectué, machine et paquet de test indisponibles. |
| Mise à jour valide de l'application installée | Non effectuée, paire de versions signées de test absente. | Non effectuée, machine et paire de versions de test indisponibles. |
| Refus d'une signature invalide par l'application installée | Non effectué. Refus vérifié uniquement sur fixtures par les tests. | Non effectué. |
| Retour à une ancienne version avec décision native | Non effectué dans une application installée. | Non effectué. |

La signature Minisign de l'updater est distincte de la signature Apple et de la
notarisation, ainsi que d'Authenticode. Le dépôt décrit les installateurs
Windows de la ligne 0.1 comme dépourvus de signature Authenticode. Aucun de ces
contrôles de distribution ne peut être déduit du succès des tests de récupération.

Aucune clé de production n'a été utilisée. Aucune version n'a été publiée,
aucun canal de mise à jour n'a été modifié et aucun commit n'a été poussé.

## Correction locale du timeout Windows

À la demande du mainteneur, la limite du job Windows passe de 20 à 40 minutes.
Dans l'exécution examinée, les préparatifs et le profil conservateur ont occupé
19 minutes avant l'étape des huit tests natifs. La nouvelle limite laisserait
donc 21 minutes pour compiler et exécuter ces tests avec les mêmes durées
préalables. Cette marge est prévue pour la compilation sans cache et les tests ;
sa suffisance sur Windows reste à confirmer lors d'une future exécution complète.

La modification conserve le profil de validation et l'étape qui exécute les
huit tests. `bun run ci:workflows` réussit. La commande
`bun test dev/ci/validate-workflows.test.ts dev/ci/ci-routing.test.ts dev/ci/native-recovery-smoke.test.ts`
donne 18 succès et aucun échec. Ces contrôles portent sur la validité et la
politique du workflow, le routage des profils et la sélection des tests natifs.
La comparaison des documents YAML confirme que seul le timeout Windows change.
Aucune exécution GitHub n'a été relancée.
