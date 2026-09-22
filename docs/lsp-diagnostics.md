# Diagnostics après édition

Les outils `write`, `edit` et `apply_patch` du backend desktop local ajoutent
une observation LSP à leur réponse JSON textuelle commune. Le transport IPC
conserve son type `String`. Les mutations restent soumises aux permissions,
aux révisions attendues et à la validation de lecture existantes.

## Configuration et autorisation

Le réglage utilisateur `languageServer` de `tools.json` est absent et désactivé
par défaut. Exemple à adapter à un serveur déjà installé :

```json
{
  "$schema": "./schemas/v1/tools.schema.json",
  "schemaVersion": 1,
  "languageServer": {
    "enabled": true,
    "executable": "/absolute/path/to/node",
    "arguments": ["/absolute/path/to/typescript-language-server/lib/cli.mjs", "--stdio"],
    "workspaceRoots": ["/absolute/path/to/worktree"],
    "waitMs": 4000
  }
}
```

Chaque racine doit être le chemin canonique exact du projet ou du worktree.
Autoriser un dépôt n'autorise pas ses autres worktrees. Ce réglage est réservé
au document utilisateur. Ses modifications par un agent ou un éditeur externe
exigent l'approbation sensible existante, y compris le changement d'exécutable,
d'arguments ou de racines. La baseline approuvée est conservée après redémarrage.

Macro lance directement l'exécutable avec un tableau d'arguments, sans shell
intermédiaire, téléchargement ni installation de serveur. L'initialisation
TypeScript transmet `disableAutomaticTypingAcquisition: true`. Le processus approuvé
reste un programme local disposant des droits de l'utilisateur. Cette liste de
racines limite les lancements de Macro, elle ne constitue pas un sandbox du
serveur. `workspace/applyEdit` reste sans handler et reçoit une erreur JSON-RPC.

## Résultat et fraîcheur

`diagnostics` contient une entrée par document observé. Chaque entrée porte
`path`, `root`, `uri`, `revision`, `session`, `version`, `status`, `items`,
`truncated` et `wait_ms`. La révision est l'empreinte du contenu écrit. Le serveur
reçoit le contenu validé, pas une relecture d'une sélection UI ultérieure.

| État | Signification |
|---|---|
| `ready` | Une publication a été reçue pour cette session et cette révision. `items: []` est une publication vide, pas une preuve de validité du projet. |
| `pending` | Aucune publication correspondante n'a été reçue dans le budget, ou une limite de lot a été atteinte. |
| `timeout` | Le démarrage n'a pas terminé dans le délai. |
| `disabled` | Aucun serveur activé dans la configuration effective. |
| `unavailable` | Exécutable absent, racine non autorisée, configuration ou document hors limites. |
| `failed` | Échec de démarrage, de protocole, de transport ou perte d'événements. |
| `stale` | Version serveur incorrecte, contenu supprimé ou changé, ou racine remplacée. Les anciens diagnostics sont retirés. |
| `cancelled` | L'attente a été annulée. Une écriture déjà validée reste appliquée. |
| `deleted` | Le document a été supprimé par le lot. |
| `unsupported` | Langage ou chemin WSL hors de cette tranche. |

Chaque document ouvre une nouvelle connexion et une seule version `1`, avec
un identifiant de session unique. Cela isole les publications sans version,
notamment celles de typescript-language-server. Une publication versionnée doit
correspondre exactement. La dernière publication reçue remplace la précédente,
y compris lorsqu'elle est vide. Macro écoute jusqu'au délai, car une liste vide
peut précéder les erreurs sémantiques. Ce protocole push ne fournit pas de signal
universel de fin d'analyse.

Les verrous de mutation sont libérés avant l'attente. Une relecture bornée par
les capacités filesystem et l'identité de la racine revalide chaque observation
à la fin du lot. Une édition concurrente ou une suppression invalide le résultat.
Les diagnostics n'annulent jamais une mutation déjà validée.

## Limites de cette tranche

- TypeScript et JavaScript, y compris TSX, JSX, MTS, CTS, MJS et CJS.
- Quatre documents par lot, vingt diagnostics par document et 2048 caractères
  par champ textuel. Les données spécifiques du serveur et documents liés sont
  exclus. Les documents dépassant 1 Mio ne sont pas envoyés.
- `waitMs` vaut 4000 par défaut, entre 100 et 10000 ms. Le budget d'observation
  de dix secondes est partagé entre les documents. Chaque connexion ajoute au
  plus 500 ms d'attente de fermeture, et chaque vérification de révision
  au plus 250 ms. Les temps de scheduling et de filesystem restent dépendants
  du système.
- Une connexion neuve coûte un démarrage de serveur et une initialisation par
  document. Un serveur froid ou une machine chargée peut retourner `pending`.
  Aucun gain de temps de correction n'est établi.
- Le cœur existant tue et récolte le processus direct. Il ne garantit pas la
  terminaison de descendants arbitraires d'un lanceur non coopératif.
- Le parcours couvert est l'exécuteur desktop local, y compris ses montages
  virtuels. Le runtime sans gestionnaire de configuration desktop reste
  désactivé. WSL, les écritures shell, les éditions externes et les outils
  fournisseurs qui contournent cet exécuteur ne déclenchent pas ces diagnostics.
- Aucune nouvelle UI. Les tests backend ne valent pas validation visuelle.

Le test Rust ignoré `real_typescript_write_error_then_edit_correction` exige
`MACRO_LSP_TEST_NODE` et `MACRO_LSP_TEST_SERVER`, deux chemins absolus vers une
installation de validation existante. Il passe par les vrais outils `write`
et `edit`, attend l'erreur 2322, puis vérifie la publication vide après correction.
Il n'installe rien. La fixture protocolaire Python couvre séparément les courses,
l'annulation et les états d'échec.
