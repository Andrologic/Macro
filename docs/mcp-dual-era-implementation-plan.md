# Plan d'implémentation du runtime MCP dual-era

Statut : approuvé pour implémentation après cinq revues OX Alpha indépendantes
et arbitrage Codex, le 24 août 2026.

## 1. But du chantier

Macro doit exécuter des serveurs MCP des deux familles de comportement :

- l'ère legacy, de `2024-10-07` à `2025-11-25`, fondée sur `initialize` et une
  session logique ;
- l'ère moderne, à partir de `2026-07-28`, fondée sur `server/discover`, des
  requêtes autonomes et les métadonnées de protocole envoyées à chaque appel.

Le support doit fonctionner avec stdio et Streamable HTTP. Le transport HTTP+SSE
historique reste un adaptateur de compatibilité distinct. Sa présence ne doit pas
compliquer le coeur dual-era.

Le chantier remplace le client MCP artisanal actuel. Il conserve les règles de
portée, de secrets et d'approbation de Macro.

## 2. Résultat attendu

À la fin du chantier, Macro possède un runtime MCP Rust persistant qui :

1. détecte ou impose l'ère de protocole pour chaque serveur ;
2. maintient les processus stdio et les sessions legacy tant qu'ils sont utiles ;
3. exécute les requêtes modernes sans état protocolaire caché ;
4. prend en charge outils, ressources, modèles de ressource et prompts ;
5. conserve les contenus structurés et les résultats demandant une interaction ;
6. applique OAuth, les secrets et la politique d'outils sans rétrogradation de
   sécurité ;
7. publie un état d'exécution observable sans l'écrire dans la configuration ;
8. passe les suites de conformité officielles ciblées pour `2025-11-25` et
   `2026-07-28`.

## 3. Hors périmètre initial

- Héberger un serveur MCP depuis Macro.
- Synchroniser les connexions MCP entre plusieurs appareils.
- Exposer MCP dans le provider headless distant avant que le runtime desktop soit
  stabilisé.
- Implémenter les extensions MCP qui ne sont pas nécessaires aux outils,
  ressources, prompts, interactions ou tâches déjà utilisées par Macro.
- Garantir HTTP+SSE historique dans le premier lot de mise en production.

## 4. Décisions d'architecture

### 4.1 Utiliser `rmcp` derrière une interface appartenant à Macro

Le backend utilisera une version exacte de `rmcp` 3.x, avec les fonctions client,
stdio, processus enfant, Streamable HTTP, OAuth, schémas et macros nécessaires.
La première version candidate est `3.1.3`, déjà utilisée par le projet Codex
local. La version finale sera vérifiée contre la suite de conformité au moment de
l'intégration.

Les commandes Tauri et les stores ne dépendront pas directement des types
internes de `rmcp`. Une interface Macro traduira les résultats vers des contrats
stables et sérialisables. Cette limite permet de mettre à jour le SDK sans
réécrire le frontend.

### 4.2 Un gestionnaire persistant possède les connexions

`McpRuntimeManager` sera un état Tauri global. Il possédera une entrée par
identité effective de serveur. Une identité comprend :

- l'identifiant canonique du serveur ;
- le transport et son empreinte de configuration ;
- la portée effective globale ou projet ;
- l'identité d'authentification, sans inclure le secret brut.

Les appels frontend utiliseront un identifiant de runtime et une génération de
configuration. Ils ne transmettront plus une définition complète de serveur à
chaque appel.

### 4.3 Séparer configuration et état observé

`tools.json` contient l'intention de l'utilisateur : serveur, transport, mode de
protocole, activation et réglages. Il ne contient pas :

- l'état en ligne ;
- la version négociée ;
- le catalogue découvert ;
- les erreurs temporaires ;
- les dates de reconnexion.

Le runtime conserve cet état en mémoire et le publie par commandes et événements
Tauri. Un cache persistant de catalogue pourra être ajouté plus tard dans les
données privées de Macro, jamais dans la configuration déclarative.

### 4.4 Une seule abstraction pour les interactions

Le frontend recevra des interactions Macro normalisées. Le backend adaptera :

- les requêtes serveur vers client de l'ère legacy ;
- les résultats `input_required` et les échanges MRTR modernes.

Le courtier d'interaction appliquera les limites de tours, les délais, les
approbations, l'annulation et la conservation exacte de `requestState`.

## 5. Modèle de configuration

Chaque serveur pourra déclarer :

```json
{
  "protocol": {
    "mode": "auto",
    "probeTimeoutMs": 2000
  },
  "startupTimeoutMs": 30000,
  "operationTimeoutMs": 60000,
  "maxConcurrentOperations": 4,
  "disabledTools": []
}
```

Les modes sont :

- `auto` : détecter l'ère et autoriser un repli protocolaire fondé sur des preuves ;
- `legacy` : utiliser directement `initialize` sans sonde ;
- `modern` : exiger une version moderne commune et refuser tout repli.

Le défaut produit sera `auto` pour les connexions persistantes créées par Macro.
L'import d'une configuration existante sans champ `protocol` conservera son
comportement legacy pendant la première migration, puis l'interface proposera
explicitement le passage en automatique. Cette règle réduit le risque de lancer
un processus supplémentaire ou de bloquer un ancien serveur silencieux lors de
la mise à jour. Le défaut des nouveaux serveurs sera `auto`.

`probeTimeoutMs` aura des bornes strictes. Les valeurs de version ne seront pas
des chaînes arbitraires dans la configuration utilisateur. Le runtime choisira
dans une liste compilée et testée.

Le délai de démarrage est distinct du délai d'une opération. Une commande lancée
par `npx` ou `uvx` peut avoir un démarrage à froid long sans justifier un délai
identique pour tous les appels suivants. Le runtime multiplexera les appels sur
une seule connexion et appliquera une limite de concurrence par serveur. Il ne
lancera pas plusieurs processus de travail pour contourner cette limite.

`disabledTools` conservera les choix durables de l'utilisateur sans sauvegarder
le catalogue découvert. Les anciens objets d'outil éventuellement présents dans
un état frontend seront lus pendant la transition, mais ne deviendront pas une
seconde source de vérité.

## 6. Négociation

### 6.1 Stdio automatique

1. Résoudre la commande, le répertoire, l'environnement et les secrets.
2. Lancer un processus de sonde frère avec le même environnement confiné.
3. Envoyer `server/discover` avec la version moderne préférée.
4. Classer comme moderne un `DiscoverResult` valide ou une erreur moderne
   reconnue qui permet une nouvelle proposition de version.
5. Classer comme legacy une méthode inconnue, une réponse non moderne, une
   fermeture du processus ou l'expiration de la sonde.
6. Fermer et récolter la sonde dans tous les cas.
7. Lancer le processus de travail dans l'ère choisie.
8. Conserver le verdict pendant la vie du processus. Refaire la sonde après un
   changement de configuration ou l'expiration du verdict mis en cache.

La sonde jetable évite d'envoyer une requête pré-initialisation au processus qui
servira la session legacy. Les limites de processus, de stderr et de reconnexion
s'appliquent aussi à cette sonde.

Ce choix diffère du mode `Auto` utilisé directement sur la connexion par Codex.
Codex exige aujourd'hui un marqueur explicite avant d'activer le stdio moderne.
Macro veut détecter un serveur inconnu. Le SDK TypeScript officiel utilise alors
un processus frère, car plusieurs serveurs legacy ferment le processus à la
première requête pré-initialisation. Macro utilisera `rmcp` pour les cycles de vie
définitifs et gardera cette pré-sonde uniquement pour `auto`. Une configuration
importée sans champ `protocol` reste legacy et ne paie pas cette sonde.

### 6.2 Streamable HTTP automatique

1. Résoudre l'authentification et la politique d'origine avant la détection.
2. Envoyer une requête moderne avec les en-têtes MCP générés par le runtime.
3. Traiter une réponse MCP moderne reconnue comme preuve de l'ère moderne.
4. Réessayer une version commune après `-32022` sans changer d'ère.
5. Autoriser le repli legacy seulement après un rejet compatible avec un serveur
   pré-2026, par exemple un `400` vide ou une erreur de méthode non reconnue.
6. Refuser le repli sur `401`, `403`, `429`, `5xx`, erreur TLS, redirection
   interdite ou corps moderne invalide.
7. En legacy, effectuer `initialize`, conserver `Mcp-Session-Id` et gérer les
   flux SSE associés selon la version négociée.

Le cache de verdict HTTP sera partitionné par URL normalisée, origine, empreinte
de transport et identité d'authentification. Un verdict legacy aura une durée de
vie courte afin de redétecter un serveur mis à jour.

L'empreinte inclura un hachage des valeurs d'environnement et des secrets
résolus. Les valeurs ne seront ni sérialisées ni enregistrées dans les logs.

### 6.3 Mode strict

Le mode `modern` échoue avec une erreur typée si `server/discover` ne prouve pas
une version commune. Le mode `legacy` n'envoie jamais de sonde moderne. Aucun
mode ne retire une authentification ou un en-tête de sécurité pour faire réussir
un repli.

## 7. Structure backend prévue

```text
src-tauri/src/mcp/
  mod.rs
  manager.rs
  client.rs
  negotiation.rs
  identity.rs
  types.rs
  catalog.rs
  interactions.rs
  cache.rs
  auth.rs
  events.rs
  transport/
    mod.rs
    stdio.rs
    streamable_http.rs
    legacy_sse.rs
```

`src-tauri/src/commands/mcp/` deviendra une couche Tauri mince. Le cadrage, le
cycle de vie et les transports n'y vivront plus.

Les principales opérations internes seront :

```rust
async fn connect(key: McpRuntimeKey) -> Result<McpRuntimeSnapshot>;
async fn disconnect(key: McpRuntimeKey) -> Result<()>;
async fn refresh_catalog(key: McpRuntimeKey) -> Result<McpCatalog>;
async fn call_tool(key: McpRuntimeKey, call: McpToolCall) -> Result<McpOperationResult>;
async fn respond_to_interaction(response: McpInteractionResponse) -> Result<McpOperationResult>;
async fn cancel(operation_id: Uuid) -> Result<bool>;
```

L'arrêt de l'application devra annuler les opérations, fermer les transports,
tuer les processus enfants confinés et attendre leur récolte avec un délai
borné.

Cette exigence dépend d'un socle absent de `core/process.rs`. Le chantier ajoutera
les groupes de processus Unix, les Job Objects Windows et un arrêt borné des
descendants avant le gestionnaire MCP persistant.

## 8. Contrats frontend prévus

Les types distingueront la configuration et l'exécution :

```ts
type MCPProtocolMode = 'auto' | 'legacy' | 'modern';
type MCPProtocolEra = 'legacy' | 'modern';
type MCPRuntimeStatus =
  | 'disconnected'
  | 'probing'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'failed';
```

`MCPOperationResult` conservera les blocs de contenu, `structuredContent`,
`isError`, `_meta`, le type de résultat, les interactions demandées et les
indications de cache. Une fonction de présentation produira du texte pour les
modèles qui ne savent consommer que du texte, sans détruire le résultat source.

`scopedMcpRuntime.ts` résoudra les définitions effectives et demandera des baux
au backend. Il ne possédera plus de cache de découverte indépendant.

`useToolsStore` conservera la configuration et les vues d'état en mémoire. Il
ne sauvegardera plus les outils découverts, `status`, `lastError` ou
`discoveredAt` dans `tools.json`.

## 9. Sécurité

Les invariants existants restent obligatoires :

- identifiants de serveur canoniques et sans collision ;
- intersection restrictive pour les tours multi-projets ;
- approbation des changements sensibles de configuration ;
- références de secrets liées au serveur et à la clé ;
- passage de chaque outil MCP dans la politique d'outils Macro.

Les protections ajoutées seront :

- validation d'origine et politique de redirection pour HTTP ;
- résolution DNS et protection SSRF alignées avec les autres accès distants de
  Macro ;
- validation de l'émetteur OAuth, PKCE et liaison du jeton à la ressource ;
- en-têtes MCP générés non surchargeables par la configuration ;
- partitionnement des caches privés par identité ;
- conservation octet pour octet de `requestState` ;
- limite de tours MRTR et limite de taille cumulée ;
- reconnexion à 500 ms, 1 s, 2 s puis 4 s, avec arrêt automatique après cinq
  déclenchements dans une fenêtre de 30 secondes ;
- limites de taille pour stdout, stderr, réponses HTTP et événements SSE ;
- annulation sans réexécution d'une opération déjà acceptée par le serveur.

Les processus stdio partiront d'un environnement vidé puis reconstruit avec une
liste de variables système autorisées, les variables déclarées par le serveur et
les secrets résolus. Le runtime n'héritera pas silencieusement des jetons du
processus Macro.

Les journaux masqueront `requestState`, `inputResponses`, les défis OAuth et les
blocs pouvant contenir une réponse utilisateur.

## 10. Lots d'implémentation

### Lot A. Contrats et socle de test

Travail :

- ajouter les types de configuration et d'exécution ;
- remplacer la fixture `Content-Length` par une fixture NDJSON conforme et
  prouver que l'ancien cadrage échoue ;
- créer les fixtures legacy et modernes ;
- ajouter une façade de runtime derrière une implémentation temporaire ;
- définir les événements de statut, catalogue et interaction ;
- conserver les commandes Tauri existantes comme adaptateurs de compatibilité.

Critères de fin :

- les configurations existantes se chargent sans réécriture ;
- les nouveaux contrats sérialisent tous les blocs de résultat utiles ;
- les tests démontrent que l'état observé n'est pas persistant ;
- au moins une fixture construite avec un SDK MCP officiel communique avec le
  harnais de test Macro.

### Lot B. Confinement des processus

Travail :

- ajouter les groupes de processus sur Unix ;
- ajouter les Job Objects sur Windows ;
- fournir un arrêt borné qui récolte aussi les descendants ;
- conserver les règles de visibilité de fenêtre de `core/process.rs`.

Critères de fin :

- un processus de test qui crée un descendant ne laisse aucun survivant après
  annulation ou fermeture ;
- les tests existent pour Unix et Windows, avec une vérification macOS dans la
  matrice de CI ;
- aucun appel MCP ne contourne les helpers de processus partagés.

### Lot C. Runtime stdio persistant legacy

Travail :

- intégrer `rmcp` ;
- corriger le cadrage stdio ;
- conserver un processus et une session par identité effective ;
- gérer pagination, annulation, sortie du processus et arrêt propre.

Critères de fin :

- une découverte puis plusieurs appels réutilisent le même processus ;
- `2025-11-25` négocie et fonctionne ;
- un crash déclenche une reconnexion bornée ;
- les processus ne survivent pas à la fermeture de Macro.

### Lot D. Négociation stdio moderne

Travail :

- ajouter la sonde frère jetable ;
- implémenter `auto` et `modern` ;
- transmettre les métadonnées modernes ;
- exposer le verdict et la raison de repli.

Critères de fin :

- les serveurs modernes ne reçoivent pas `initialize` ;
- les serveurs legacy ne reçoivent pas la sonde sur leur processus de travail ;
- les erreurs modernes reconnues ne provoquent pas de rétrogradation ;
- les modes stricts échouent avec une erreur exploitable.

### Lot E. Streamable HTTP et authentification statique

Travail :

- extraire une protection SSRF commune depuis le chemin de recherche web ;
- ajouter HTTP legacy et moderne ;
- mettre en place les règles de repli fondées sur le statut et le corps ;
- prendre en charge les références secrètes d'en-tête actuellement refusées ;
- gérer les réponses JSON et SSE liées à une requête.

Critères de fin :

- les quatre combinaisons HTTP legacy ou moderne, public ou bearer statique,
  fonctionnent ;
- `401`, `403` et `5xx` ne déclenchent jamais de repli ;
- aucun secret ou catalogue privé ne traverse une identité de cache.

### Lot F. OAuth complet

Travail :

- découverte RFC 9728 ;
- PKCE et validation `iss` RFC 9207 ;
- enregistrement dynamique ou métadonnées client quand disponibles ;
- indicateurs de ressource, défis de portée, renouvellement et verrou de refresh ;
- stockage privé et parcours navigateur.

Critères de fin :

- un changement d'émetteur échoue fermé ;
- une augmentation de portée relance le parcours sans perdre l'opération ;
- aucun jeton ne traverse la configuration, les événements ou les logs ;
- deux identités OAuth vers la même URL ne partagent aucun cache privé.

### Lot G. Interactions et résultats backend

Travail :

- préserver le résultat MCP complet ;
- relier les requêtes legacy et MRTR au courtier d'interaction ;
- exposer un trait d'approbation injecté, fermé par défaut ;
- ajouter annulation, limites et traces.

Critères de fin :

- `requestState` revient sans modification ;
- un dépassement de tours s'arrête proprement ;
- une annulation interrompt le transport sans rejouer l'appel ;
- les résultats texte, image, ressource et structurés restent accessibles.

### Lot H. Catalogue, cache et abonnements

Travail :

- outils, ressources, modèles de ressource et prompts paginés ;
- validation de `x-mcp-header` et génération contrôlée des en-têtes
  `Mcp-Param-*` ;
- `ttlMs`, `cacheScope` et invalidation ;
- notifications legacy et `subscriptions/listen` moderne ;
- reprise des abonnements après reconnexion.

Critères de fin :

- la pagination ne perd ni ne duplique d'élément ;
- un cache privé reste lié à son utilisateur et à sa portée ;
- une notification ou un abonnement rafraîchit le bon catalogue ;
- une reconnexion ne crée pas plusieurs abonnements identiques.

### Lot I. État frontend, approbations et interface

Travail :

- brancher les événements du runtime ;
- retirer la persistance des données observées ;
- relier le trait d'approbation backend aux décisions Macro ;
- afficher mode demandé, ère, version, transport, OAuth et raison de repli ;
- ajouter reconnecter, renégocier et annuler.

Critères de fin :

- l'interface reflète un crash et une reconnexion sans sauvegarder la panne ;
- le changement de configuration invalide la bonne génération ;
- les chaînes sont traduites dans toutes les langues prises en charge ;
- l'interface reste utilisable avec un serveur legacy existant non migré.

### Lot J. Compatibilité historique et nettoyage

Travail :

- décider à partir des usages réels si HTTP+SSE historique doit être livré ;
- ajouter l'adaptateur si la décision est positive ;
- retirer le client artisanal et les adaptateurs Tauri obsolètes ;
- mettre à jour la documentation d'architecture et de configuration.

Critères de fin :

- aucun chemin d'exécution n'utilise `Content-Length` pour MCP stdio ;
- aucun type de transport annoncé comme supporté ne renvoie une erreur générique
  disant qu'il ne l'est pas ;
- la documentation distingue protocole, cycle de vie et transport.

## 10.1 Arbitrages issus des revues croisées

- L'ancien client artisanal n'est pas un moteur de secours, car son cadrage est
  non conforme. Le secours utilise `rmcp` en mode éphémère.
- La sonde stdio frère reste retenue pour les serveurs inconnus en mode `auto`.
  Codex sonde sur la connexion seulement après une activation explicite. Le SDK
  TypeScript officiel confirme la nécessité du processus frère pour une
  détection transparente.
- Le confinement des processus devient un lot préalable au runtime persistant.
- Streamable HTTP avec bearer statique et OAuth complet sont deux lots séparés.
- Le backend d'interaction est fermé par défaut. Le branchement aux approbations
  frontend arrive après stabilisation de son contrat.
- HTTP+SSE historique reste une décision fondée sur l'usage, pas une conséquence
  automatique de l'adoption de `rmcp`.
- Une perte de transport après l'envoi d'un outil modifiant produit un résultat
  indéterminé. Macro ne rejoue jamais cet appel. Une lecture explicitement
  idempotente peut être réémise avec un nouvel identifiant.

## 11. Matrice de validation

Chaque ligne sera testée en mode normal, erreur, annulation et reconnexion quand
le transport le permet.

| Transport | Ère | Authentification | Exigence |
|---|---|---|---|
| stdio | legacy | environnement | obligatoire |
| stdio | moderne | environnement | obligatoire |
| Streamable HTTP | legacy | aucune | obligatoire |
| Streamable HTTP | legacy | OAuth | obligatoire |
| Streamable HTTP | moderne | aucune | obligatoire |
| Streamable HTTP | moderne | OAuth | obligatoire |
| HTTP+SSE | legacy ancien | en-têtes ou OAuth | décision au lot J |

Cas de négociation obligatoires :

- découverte moderne réussie ;
- version moderne non supportée avec liste de versions ;
- méthode inconnue corrélée ;
- erreur avec mauvais identifiant ;
- expiration de sonde stdio ;
- processus qui quitte pendant la sonde ;
- HTTP `400` vide ;
- HTTP `400` avec erreur moderne ;
- HTTP `405` indiquant un endpoint SSE historique ;
- HTTP `401`, `403`, `429` et `5xx` ;
- expiration de `Mcp-Session-Id` pendant une session legacy ;
- incohérence `-32020` entre corps et en-têtes ;
- redirection inter-origine ;
- verdict mis en cache devenu faux.

Les tests seront répartis entre :

- tests unitaires Rust pour négociation, identité, cache et sécurité ;
- tests d'intégration Rust avec serveurs factices stdio et HTTP ;
- tests frontend pour contrats, stores et événements ;
- suite officielle `@modelcontextprotocol/conformance` pour les deux versions ;
- tests manuels ciblés avec au moins un serveur réel legacy et un serveur moderne.

Le dépôt ajoutera un petit binaire client de conformité. Il lira
`MCP_CONFORMANCE_SCENARIO`, `MCP_CONFORMANCE_CONTEXT` et
`MCP_CONFORMANCE_PROTOCOL_VERSION`, puis exercera la même bibliothèque que
Macro. La version npm du runner sera épinglée. Une dérogation attendue devra
avoir un propriétaire, une justification et une date d'expiration.

## 12. Livraison et retour arrière

Le runtime sera introduit derrière un sélecteur interne pendant les lots A à G.
Les anciennes commandes Tauri resteront disponibles comme adaptateurs de contrat
tant que le frontend n'utilise pas les nouvelles commandes. Elles appelleront le
runtime `rmcp`. Le client artisanal actuel ne sera pas conservé comme moteur de
secours, car son cadrage stdio n'est pas conforme. Le mode de secours sera un
client `rmcp` éphémère, sans conservation de connexion, sélectionnable par
serveur pendant la phase de validation.

Le code ancien sera supprimé seulement après :

1. passage des tests legacy avec `rmcp` persistant et éphémère ;
2. passage des tests modernes ;
3. migration de l'interface et des stores ;
4. validation d'un arrêt propre sur macOS, Linux et Windows ;
5. absence de régression sur la politique multi-projets et les secrets.

Les changements de schéma restent rétrocompatibles dans la version 1. Ajouter un
champ optionnel ne force aucune réécriture. Une version de schéma supérieure ne
sera créée que si une migration destructive devient nécessaire.

## 12.1 Confidentialité des capacités clientes

Macro n'annoncera aucune capacité cliente sans implémenter sa politique. En
particulier, `roots` reste désactivé tant que le produit n'a pas défini quelles
racines peuvent être révélées au serveur, dans quel scope et après quelle
approbation. Une requête serveur legacy non prise en charge recevra une erreur
JSON-RPC corrélée. Elle ne sera ni ignorée ni considérée comme une notification.

Le même principe s'applique à l'échantillonnage et à l'élicitation. Leur
adaptation au courtier d'interaction doit précéder leur annonce dans les
capacités clientes.

## 13. Barrières de revue

Chaque lot exige :

- une revue de son diff limitée à sa responsabilité ;
- les tests ciblés du lot ;
- `bun run typecheck` pour les contrats frontend modifiés ;
- `cargo test --manifest-path src-tauri/Cargo.toml` pour le runtime Rust modifié ;
- `bun run ci:pre-push` avant toute publication distante.

La suite complète de conformité et `bun run ci` seront exécutés avant la fin du
chantier, pas après chaque petit changement.

## 14. Définition de fini

Le chantier est fini lorsque :

- les deux ères fonctionnent sur stdio et Streamable HTTP ;
- le mode négocié apparaît dans les diagnostics ;
- aucun état réseau temporaire n'est persisté dans la configuration ;
- les résultats et interactions modernes ne perdent aucune donnée ;
- les règles de secrets, de portée et d'approbation sont couvertes par des tests ;
- les suites de conformité ciblées passent sans dérogation propre à Macro ;
- les processus, flux et opérations s'arrêtent proprement ;
- la documentation décrit le comportement livré et ses limites ;
- le client MCP artisanal n'est plus utilisé en production.

## 15. Sources de référence

- Spécification MCP `2025-11-25` :
  https://modelcontextprotocol.io/specification/2025-11-25
- Spécification MCP `2026-07-28` :
  https://modelcontextprotocol.io/specification/2026-07-28
- SDK Rust officiel : https://github.com/modelcontextprotocol/rust-sdk
- SDK TypeScript officiel : https://github.com/modelcontextprotocol/typescript-sdk
- Suite de conformité : https://github.com/modelcontextprotocol/conformance
- Client MCP Codex :
  `/Users/oscarlahaie/github/codex/codex-rs/rmcp-client`
- Runtime MCP Oh My Pi :
  `/Users/oscarlahaie/github/oh-my-pi/packages/coding-agent/src/mcp`
