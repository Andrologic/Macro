# Configuration JSON de Macro

## 1. Principes

Macro utilise un registre de configuration Rust unique pour le desktop, le
runtime headless, l’interface et les agents. Les structs Rust, leurs valeurs par
défaut et le catalogue des paramètres sont la source de vérité. Les fichiers
JSON sont une représentation éditable et clairsemée de ce registre.

Les règles structurantes sont les suivantes :

- le format est du JSON strict, sans commentaires JSONC ;
- une propriété absente hérite du scope inférieur ou de la valeur par défaut ;
- une valeur égale à sa valeur par défaut n’est pas conservée sur disque ;
- chaque écriture est validée avant de devenir effective ;
- une modification concurrente doit fournir le dernier ETag ;
- une modification sensible venant d’un agent ou d’un éditeur externe attend
  une validation explicite de l’utilisateur ;
- une erreur dans un fichier ne remplace jamais le dernier snapshot valide ;
- les secrets ne font jamais partie d’un document, d’un snapshot ou du scope
  agent `@config`.

## 2. Emplacements

Le dossier global est le dossier de configuration de l’application fourni par
Tauri. `MACRO_CONFIG_DIR` peut le remplacer si sa valeur est un chemin absolu.
Cette variable sert notamment aux tests, au runtime headless et aux
installations portables.

```text
<app-config-dir>/
  runtime.json
  settings.json
  agents.json
  providers.json
  tools.json
  skills.json
  git.json
  schemas/
    v1/
      runtime.schema.json
      settings.schema.json
      agents.schema.json
      providers.schema.json
      tools.schema.json
      skills.schema.json
      git.schema.json
```

`MACRO_CONFIG` reste accepté comme alias déprécié du bootstrap headless. Toute
nouvelle intégration doit utiliser `MACRO_CONFIG_DIR`.

Les surcharges projet sont stockées dans la branche metadata `@macro` :

```text
@macro/projects/<project-id>/config/
  agents.json
  tools.json
  skills.json
  git.json
```

Les fichiers `runtime.json`, `settings.json` et `providers.json` sont toujours
globaux.

L’état temporaire de l’interface est séparé dans `state.json`, sous le dossier
de données de l’application. Les conversations, terminaux, caches de modèles,
statuts d’authentification et journaux restent dans SQLite. Les plans et
artefacts restent dans `@macro`.

## 3. Documents

Chaque fichier commence au minimum par :

```json
{
  "$schema": "./schemas/v1/settings.schema.json",
  "schemaVersion": 1
}
```

| Document | Responsabilité |
|---|---|
| `runtime.json` | Workspace par défaut, paramètres headless, racines autorisées et réglages nécessitant un redémarrage |
| `settings.json` | Langue, apparence, zoom, code, raccourcis, notifications et applications d’ouverture |
| `agents.json` | Prompts, limites de tours, compaction, revues, modèles dédiés et smart commit |
| `providers.json` | Fournisseurs IA et vocaux, modèles manuels, overrides et dictée |
| `tools.json` | Risque, outils par mode, recherche web, MCP, commandes projet et changement de projet |
| `skills.json` | Racines, destinations d’installation, priorités et permissions de skills |
| `git.json` | Branches, modèles de noms, politiques de merge et synchronisation metadata |

Les propriétés inconnues sont refusées, sauf dans les maps extensibles prévues
par les schémas et dans le champ réservé `extensions`.

Un fichier dont `schemaVersion` est supérieur à la version prise en charge est
chargé en lecture seule. Macro ne le réécrit jamais avec un schéma plus ancien.

## 4. Scopes, fusion et provenance

La priorité est fixe :

```text
valeurs par défaut
< configuration utilisateur
< surcharge projet autorisée
< surcharge de session non persistante
```

Les objets identifiés utilisent des maps indexées par identifiant stable. Les
tableaux sont remplacés, sauf lorsqu’un descripteur déclare un comportement
additif. Les stratégies disponibles sont `replace`, `deep`, `keyed` et
`restrictive`.

Les surcharges projet sont volontairement limitées :

- `agents.json` peut sélectionner des modèles et réduire des limites, sans
  remplacer les prompts système globaux ;
- `tools.json` peut désactiver des outils et ajouter des MCP projet, sans
  réactiver un outil désactivé globalement ;
- `skills.json` peut ajouter des racines et destinations projet, sans accorder
  sa propre confiance ;
- `git.json` peut remplacer les réglages propres au dépôt.

Dans un contexte multi-projet, un outil doit être autorisé par le scope global
et par tous les projets affectés. Les limites numériques prennent la valeur la
plus restrictive. Un modèle projet n’est utilisé que si le projet cible ou le
projet de focus est sans ambiguïté.

Le snapshot contient la provenance de chaque valeur : `default`, `user`,
`project` ou `session`. L’interface l’affiche sans recopier les valeurs héritées
dans les fichiers.

## 5. Édition et rechargement

Les réglages proposent les actions suivantes :

- ouvrir le fichier JSON ou son dossier sur le desktop ;
- valider le brouillon sans l’écrire ;
- enregistrer une version complète ;
- recharger depuis le disque ;
- réinitialiser le document vers sa forme minimale ;
- inspecter les diagnostics, la provenance et les changements sensibles en
  attente.

Une écriture utilise JSON Patch RFC 6902 et un `expectedEtag`. Le backend prend
un verrou par document, applique le patch en mémoire, valide le schéma et les
règles sémantiques, classe le diff, synchronise un fichier temporaire, remplace
le fichier atomiquement, puis publie le nouveau snapshot.

Si l’ETag a changé, l’écriture échoue avec un conflit et le document courant.
Macro n’écrase pas silencieusement une version plus récente.

Le watcher applique un debounce et reconnaît les écritures internes par leur
hash. Une modification externe invalide laisse le dernier snapshot valide
actif et bloque les écritures ordinaires vers ce document. Une réécriture
explicite du document complet permet de le réparer.

Les modes d’application sont :

- `live` : application immédiate ;
- `reconnect` : rechargement du fournisseur, du serveur MCP ou du catalogue
  concerné ;
- `restart` : changement enregistré, signalé comme nécessitant un redémarrage.

## 6. Modifications sensibles

Les changements suivants attendent toujours une validation lorsqu’ils viennent
d’un agent ou d’un éditeur externe :

- augmentation du niveau de risque ;
- ajout ou modification d’une commande externe ;
- ajout ou modification d’un serveur MCP exécutable ;
- ajout d’un endpoint distant pouvant recevoir du code ou de l’audio ;
- autorisation d’une racine hors projet ;
- écoute headless sur une adresse non loopback ;
- activation des scripts d’une skill ou attribution de sa confiance ;
- relâchement d’une restriction héritée.

L’approbation porte sur le document complet proposé. Elle ne peut pas être
mémorisée comme autorisation générale. En cas de refus, l’utilisateur peut
demander la restauration explicite de la dernière version approuvée.

## 7. Secrets

Les secrets utilisent des références `macro-secret://...`. Les champs tels que
`apiKey`, `token` et `password` en clair sont refusés par la validation. Les
agents voient seulement les références et les indicateurs `hasSecret`.

`provider-secrets.json` reste sous le dossier de données privé de
l’application. Il est écrit atomiquement, avec une sauvegarde avant changement
de version, des permissions Unix `0600` et une ACL Windows limitée à
l’utilisateur courant. Ses namespaces séparent les fournisseurs, la dictée,
les MCP, la recherche web et les secrets système.

Supprimer un fournisseur ou une intégration ne supprime pas son secret. La vue
de configuration liste les secrets devenus orphelins et exige une action de
suppression distincte. Aucune valeur secrète n’est renvoyée par cette liste.

## 8. Skills

`skills.json` configure :

- les racines conventionnelles `.agents`, `.codex`, `.opencode` et `.claude` ;
- les racines locales personnalisées ;
- leur priorité déterministe dans chaque scope ;
- les destinations d’installation globales et projet ;
- la destination par défaut de chaque scope ;
- l’activation, les scripts et la confiance de chaque skill.

Les chemins développent uniquement `${home}`, `${projectRoot}` et
`${configDir}`. Une racine projet relative part de la racine canonique du
projet et ne peut pas s’en échapper.

L’identité persistante d’une skill combine l’identifiant stable de sa racine et
son chemin relatif. Le hash de contenu couvre `SKILL.md`, les références, les
scripts et les autres ressources chargeables. Une modification invalide la
confiance effective : `scriptsEnabled` peut rester demandé, mais aucun script ne
s’exécute tant que le nouveau hash n’a pas été approuvé par l’utilisateur.

Les permissions de confiance restent exclusivement dans le `skills.json`
global. Supprimer une racine ou une destination de la configuration ne supprime
jamais les fichiers présents sur disque. Les sources HTTP, Git et registry ne
font pas partie de la version 1.

## 9. Accès des agents

Les agents disposent des outils structurés :

- `config_list` ;
- `config_get` ;
- `config_validate` ;
- `config_patch`.

`config_patch` exige l’ETag renvoyé par `config_get`. Il utilise le même moteur
de validation et d’approbation que l’interface.

Les outils de fichiers peuvent aussi parcourir le scope virtuel :

```text
@config/user/<document>.json
@config/projects/<project-id>/<document>.json
```

`read`, `list`, `write`, `edit`, `delete` et `apply_patch` sont interceptés et
routés vers `ConfigManager`. Aucun chemin physique vers le fichier de secrets
n’est exposé. Un `apply_patch` visant `@config` doit modifier un seul document et
ne peut pas mélanger configuration et fichiers de workspace dans la même
opération.

## 10. Headless

Le runtime headless charge le même `ConfigManager`. Son API authentifiée expose
le snapshot, les documents, les schémas, la validation, les patches, le
rechargement et la revue des changements sensibles sous `/api/v1/config/*`.

Pour isoler une exécution :

```powershell
$env:MACRO_CONFIG_DIR = "C:\chemin\absolu\vers\macro-config"
bun run tauri:headless
```

Le fichier `runtime.json` détermine les réglages headless et les racines
autorisées. Une adresse d’écoute non loopback est classée sensible.

## 11. Diagnostics courants

| Code ou situation | Comportement |
|---|---|
| JSON invalide | Le fichier reste intact et le dernier snapshot valide continue de fonctionner |
| Propriété inconnue | La validation refuse la propriété et indique son pointeur JSON |
| Secret en clair | La validation exige une référence `macro-secret://` |
| ETag obsolète | L’écriture échoue avec le document et l’ETag courants |
| Version future | Le document est disponible en lecture seule |
| Changement sensible externe | Le fichier reste sur disque, mais l’ancienne version reste effective jusqu’à la décision |
| Chemin de skill hors scope | La racine est refusée après canonicalisation |
| Hash de skill modifié | La confiance effective et l’exécution des scripts sont suspendues |
| Détection Git ambiguë | Le `git.json` projet reçoit l’état `configuration_required` |

## 12. Ajouter ou retirer un paramètre

Pour ajouter un paramètre durable :

1. ajouter le champ à la struct Rust du document concerné ;
2. définir sa valeur par défaut ;
3. ajouter son descripteur au catalogue avec le document, le pointeur JSON, les
   scopes, la stratégie de fusion, la sensibilité et le mode d’application ;
4. ajouter la validation sémantique si le schéma ne suffit pas ;
5. exécuter `bun run config:generate` ;
6. ajouter un test ciblé de validation, de fusion ou de sécurité ;
7. exécuter `bun run config:check`.

Pour retirer un paramètre, le marquer d’abord comme déprécié, fournir la
migration de schéma nécessaire, puis le marquer comme supprimé. Le test de
couverture du catalogue garantit qu’aucune propriété terminale du schéma ne
reste sans descripteur et qu’aucun descripteur ne cible une propriété supprimée.

Il ne faut jamais créer un nouveau stockage ad hoc pour un réglage qui entre
dans l’un des sept documents existants.

## 13. Compatibilité avec l’ancienne configuration

La première activation ne migre aucun ancien réglage. Macro recrée des fichiers
propres avec les valeurs par défaut. Les anciennes clés `localStorage`, les
stores Tauri et les tables historiques restent physiquement présents pendant
une version pour permettre un retour arrière, mais ne sont ni lus ni écrits
comme source de configuration.

Les conversations, plans, projets, worktrees, caches et autres données métier
ne sont pas réinitialisés. La suppression physique des anciennes colonnes et
tables fera l’objet d’une migration ultérieure après la période de
compatibilité.
