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
`truncated` et `wait_ms`. Les champs `workspace_path`, `document_path` et
`root_identity` lient chaque observation à sa cible native capturée. La révision est l'empreinte du contenu écrit. Le serveur
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

- Le code sélectionne TypeScript et JavaScript, y compris TSX, JSX, MTS, CTS,
  MJS et CJS. La preuve avec un serveur réel porte uniquement sur `.ts`.
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

## Checkpoints conversationnels et preuves par parcours

Les conversations desktop conservent leurs snapshots avant/après et leur
sauvegarde de checkpoint. `write` et le contenu calculé par `edit` passent par
la transaction native `write` avec la révision attendue. `apply_patch` conserve
sa transaction native par lot. Le résultat conversationnel reprend les
observations natives après sauvegarde du checkpoint. Une relecture confinée de
chaque document observé compare sa révision et l'identité native de sa racine.
Elle utilise `workspace_path` et `document_path` capturés par le backend, même
si deux montages contiennent le même chemin relatif. Le DTO de lecture retourne
`workspace_identity` seulement si l'identité de la racine a été vérifiée avant
et après la lecture. Ces identifiants sont des chaînes opaques préservant les
entiers natifs : device/inode sur Unix, volume/index de fichier sur Windows.
Ils ne sont ni un chemin canonique ni une empreinte du document.

Un remplacement de racine au même chemin invalide donc l'observation, même à
contenu identique. Une identité absente, une erreur de lecture ou une révision
modifiée produit `stale` sans items. La racine stable d'un autre montage garde
ses diagnostics vérifiés. Un ancien runtime sans cette preuve ne peut plus
conserver `ready` après checkpoint ; l'écriture reste réussie.
Cette vérification supplémentaire partage un budget de 250 ms pour le checkpoint
et s'interrompt à l'annulation. Une observation non vérifiée dans ce budget
produit `stale`. Un appel filesystem déjà lancé peut finir en arrière-plan,
sans modifier le résultat publié.

Si le checkpoint échoue, la compensation existante reste conditionnée par la
révision appliquée. Elle préserve une écriture concurrente et ne publie aucun
diagnostic de la mutation annulée. L'AbortSignal transmet un identifiant aux
trois mutations natives. L'arrêt coupe l'observation accessoire ; il conserve
l'écriture validée et son checkpoint, puis empêche le prochain tour annulé.
Les anciens runtimes retournant `UNSUPPORTED_WORKSPACE_TOOL` conservent leur
fallback filesystem, sans preuve LSP.

| Parcours | Preuve obtenue | Limite |
|---|---|---|
| Exécuteur Rust desktop, `.ts`, stdio TypeScript réel | `write` produit 2322, `edit` le corrige, publication vide et nouvelle révision/session | Configuration injectée pour le test ; aucune conversation ni UI |
| Conversation desktop, racine directe ou montage virtuel, fixture `.ts` | Répartiteur, runtime, exécuteur et batch d'outils réels ; `write`, `edit`, `apply_patch`, checkpoints, refus, rollback, concurrence et annulation. Cas de remplacement réel de répertoire, témoin stable et deux montages | IPC natif et persistance simulés ; filesystem réel pour les cas de remplacement |
| Identité native après réponse, serveur protocolaire de test | Les trois mutations natives, directes et virtuelles, rendent une identité retrouvée par le lecteur natif ; elle diffère après remplacement de racine malgré des octets identiques | Serveur LSP simulé ; pas de Tauri UI |
| Projection OpenAI Chat Completions | Le JSON et ses états arrivent dans l'élément `tool` destiné à la prochaine requête ; cycle erreur/correction programmé | Codec réel, aucun appel fournisseur et aucune correction autonome |
| Responses, Anthropic, Copilot et autres codecs | Aucune preuve LSP spécifique dans ce lot | Les tests génériques de transport ne prouvent pas ce parcours |
| JavaScript, JSX, TSX, MTS, CTS, MJS, CJS | Sélection implémentée par extension | Aucun cycle erreur/correction avec serveur réel établi |
| Remote kernel, WSL, shell et éditions externes | Aucune preuve conversationnelle LSP | Voir les limites de périmètre ci-dessus |

Le test réel dure environ 21 secondes pour deux observations. Il ne mesure
ni le délai d'une réparation autonome ni le nombre de requêtes économisées.
Aucun gain produit n'est revendiqué et aucune UI n'a été exercée.
