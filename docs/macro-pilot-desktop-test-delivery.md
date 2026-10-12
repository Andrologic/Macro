# Préparer une application desktop de test pour Pilot

Cette procédure couvre le point 21 desktop après intégration des réflexions visibles. Elle prépare un build local pour la recette conjointe desktop, relais et mobile. La racine choisit la version commune et autorise les étapes de livraison suivantes.

## État du candidat

La base source vérifiée est `dd86e1c8aee58f9041c1d71a0d75a67fef343c35`. La version actuelle reste `0.1.8`. `package.json` est la source de version ; Cargo.toml, Cargo.lock, Tauri et flake.nix sont cohérents selon `bun run version:check`. Tauri référence directement `../package.json`, et Vite injecte cette version dans le frontend.

Le poll v2 accepte ensemble les treize capacités suivantes :

- `task-details-1`, `task-actions-1` ;
- `network-reliability-1` ;
- `conversations-1`, `conversation-history-1`, `conversation-interactions-1`, `conversation-models-1` ;
- `host-telemetry-1`, `project-icons-1` ;
- `attachment-transfer-1`, `conversation-attachments-1`, `conversation-files-1` ;
- `conversation-reflections-1`.

Les validateurs portable et navigateur imposent treize éléments uniques au maximum. Le runtime annonce les capacités selon les ports disponibles. Les réflexions exigent aussi conversations ; les modèles exigent le port providers. Lors d'un premier poll refusé par 400 ou 422, le runtime retire les réflexions avant les autres groupes, puis poursuit la négociation. Une annonce compatible ne prouve pas que le relais et le mobile ont raccordé chaque opération.

## Vérifications effectuées

Sur cette base, les 200 fixtures des 34 opérations passent, ainsi que les associations, la pagination, l'UTF-8 et les contrôles d'intégrité. Le poll conjoint passe dans les deux validateurs ; une répétition et une quatorzième capacité sont refusées.

Les tests runtime, contrat réflexions et génération passent avec 28 réussites et un test ignoré nécessitant des captures Git natives. Huit suites supplémentaires passent avec 66 réussites : tâches, machines, émissions, pièces jointes et gestion des conversations. Ces contrôles utilisent des données synthétiques et des ports simulés.

La compilation native, les trois tests SQLx du lecteur et les 144 tests DB réussis avec un ignoré proviennent de la livraison précédente sur cette même base. Le contrôle IPC généré sans écriture y passe aussi. Cette préparation ne les présente pas comme une nouvelle compilation d'application empaquetée.

Le premier build de production a dépassé les budgets pour l'entrée et nativeClient. La correction partage les fonctions Ajv des schémas référencés, utilise des boucles pour les listes required longues et sépare la projection Markdown, les validateurs A1 et la validation content. Les schémas, le helper canonique, les types générés et les seuils de budget restent inchangés.

Le build frontend corrigé réussit avec 5 115 modules transformés et `bun run bundle:check` passe. Tailles mesurées :

| Asset | Taille réelle | Budget applicable |
| --- | ---: | ---: |
| entrée index | 1 538 253 octets | 1 542 000 octets |
| transport nativeClient | 61 282 octets | 830 000 octets |
| nativeClient-content-validation | 785 223 octets | 830 000 octets |
| pilot-schema-validators | 418 700 octets | 600 000 octets |
| markdown-render-projection | 12 667 octets | 600 000 octets |

La validation content conserve le budget existant des chunks du transport natif ; aucun nouveau seuil ni exception n'est ajouté. Le découpage ne prétend pas réduire le volume total à lui seul. Le partage de génération Ajv réduit le code répété, et la séparation permet de contrôler les chunks indépendamment. Le graphe de chargement doit être joint aux preuves, avec comparaison à la base. Les tests de génération vérifient la conformité et l'absence d'eval ou Function ; l'audit indépendant porte sur la correction complète.

Les journaux et hashes de cette préparation sont livrés hors du dépôt.

## Procédure pour le bundle local

1. Fixer avec la racine le SHA source et la version de recette commune au mobile. Garder les versions présentes jusqu'à cette décision. Si une version est décidée, utiliser le workflow de synchronisation de versions existant et relancer son contrôle.
2. Utiliser un worktree dédié, les dépendances locales déjà installées et le target Cargo réutilisable. Vérifier l'espace libre avant compilation. Les artefacts restent hors Git et hors du répertoire d'installation.
3. Confirmer localement que le runtime Bun de l'architecture hôte peut être compilé sans téléchargement et que tous les crates du lockfile sont disponibles. `dev/build-ai-runtime.mjs` invoque `bun build --compile --target=bun-darwin-arm64` sur un hôte macOS ARM64. Le script ne fournit pas de garantie hors ligne. La cible universal ajoute une compilation x64 et `lipo` ; elle n'est pas nécessaire pour cette première recette ARM64.
4. Vérifier le comportement du CLI Tauri installé pour une signature ad hoc et l'absence d'accès au trousseau. Préparer un environnement de build limité aux outils, SDK et caches nécessaires, sans variables de certificat ni de notarisation. Utiliser l'identité ad hoc `-` uniquement après ce contrôle. Le helper de QA macOS signé n'appartient pas à cette préparation.
5. Lorsque ces conditions sont établies, utiliser le chemin de build local existant. La commande de référence pour un bundle app de debug sur l'architecture hôte est :

   ```sh
   CARGO_NET_OFFLINE=true APPLE_SIGNING_IDENTITY=- \
     bun run tauri:build:debug --bundles app
   ```

   Définir auparavant `CARGO_TARGET_DIR` vers le cache réservé et appliquer l'environnement limité de l'étape précédente. Cette commande exige les protections de l'étape précédente ; le build de cette livraison utilise en plus un confinement macOS appliqué à tous ses processus enfants. Son mode hors ligne protège Cargo ; il ne garantit pas à lui seul le comportement de la compilation Bun. Le fichier public `tauri.local.conf.json` désactive les artefacts updater. Le beforeBuildCommand compile le runtime AI puis le frontend. Conserver les ressources Copilot et les licences prévues par la configuration Tauri.
6. Si une condition manque, livrer la préparation et nommer le prérequis restant. Ne pas substituer un binaire de tests Rust à une app complète. Une fois le bundle produit, relever SHA source, version, architecture, mode debug/release, taille réelle et SHA-256 de chaque artefact. Vérifier les ressources, la signature ad hoc et les dépendances du bundle sans le lancer ni l'installer. Produire un DMG seulement si cette forme est ensuite demandée et ses prérequis locaux vérifiés.

Les scripts actuels de bundle ne garantissent pas seuls l'absence de téléchargement. Un premier bundle ARM64 debug a toutefois été produit dans un confinement macOS interdisant le réseau, l'exécution de security et les accès aux trousseaux. Le build utilise Cargo hors ligne, une identité ad hoc et un environnement limité sans secrets de signature. Les probes du confinement et la compilation du runtime Bun local passent. La reconstruction depuis le commit final et la vérification de sa signature et de ses ressources doivent être liées au SHA livré. Aucun paramètre privé de signature n'est lu ni modifié.

## Recette matérielle restante

Après autorisation de lancement et raccord des trois clients, vérifier sur les appareils retenus les conversations Chat et Implement, l'historique, les interactions et modèles, les tâches, les fichiers, les machines, puis les réflexions historiques et actives. Rejouer déconnexion, reprise, expiration, révocation et changement de politique. Pour les réflexions mobiles, vérifier l'option désactivée et les blocs repliés par défaut, avec aucune lecture tant que le bloc est fermé.

Mesurer alors latence entre clients, consommation mémoire et CPU, volume réseau, rendu WebView, taille et démarrage de l'application complète. Ces mesures, le comportement réel des providers, le trousseau, l'installation, la mise à jour et les plateformes Windows, Linux et macOS Intel ne sont pas validés par cette préparation. Le build frontend mesure des octets d'assets, pas le RSS ni la taille d'une app Tauri. Aucun appareil ou provider réel n'a été utilisé, aucune application installée ou remplacée, aucun push ou publication effectué.
