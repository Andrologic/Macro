# Claude avec les outils Macro contrôlés

Le binding Engine utilise le contrat `macro/agent-engine`, version `1`, et
l’implémentation `anthropic/claude-agent-sdk`, version `1`. Son fournisseur natif
réservé est `claude-native`. Le sélecteur propose uniquement les modèles canoniques
observés dans le SDK. Les bindings existants Macro et Codex gardent leur politique.

Ce profil fournit au SDK seulement les alias d’outils Macro capturés et une
fonction de publication AgSDL. Les outils intégrés Claude sont désactivés. Il
n’utilise pas les outils natifs Codex ni son modèle de permissions.

## Installation externe et accès

Macro ne distribue ni le SDK Anthropic ni son CLI. Installez séparément
`@anthropic-ai/claude-agent-sdk@0.3.308`, ses dépendances dont Zod et le paquet
natif correspondant à la plateforme. Consultez le
[quickstart officiel](https://platform.claude.com/docs/en/agent-sdk/quickstart).
Le CLI attendu annonce `2.1.308`. Le profil est qualifié sur Linux arm64 ; les
autres plateformes restent indisponibles avec un diagnostic.

Avant de lancer Macro, configurez trois chemins absolus :

```sh
export MACRO_CLAUDE_NODE=/path/to/node
export MACRO_CLAUDE_SDK=/path/to/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
export MACRO_CLAUDE_CLI=/path/to/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude
```

Zod doit se trouver dans le même `node_modules` que le paquet SDK. Macro capture
les empreintes de Node, du SDK, du CLI, des fichiers Zod et de son runner original.
Une installation absente ne déclenche aucun téléchargement automatique.

La configuration de l’Agent permet d’enregistrer une clé API Anthropic dans le
magasin de secrets Macro existant. Elle ne rejoint pas le document AgSDL ni les
snapshots publics. Le profil utilise cette clé explicitement ; il n’importe pas
les credentials d’une installation Claude personnelle et n’offre pas de login
OAuth Macro. Aucun login n’est lancé automatiquement.

Si votre clé exige un workspace Anthropic explicite, fournissez aussi
`MACRO_CLAUDE_WORKSPACE_ID` avant de démarrer Macro. Le runner transmet uniquement
ce sélecteur via `ANTHROPIC_CUSTOM_HEADERS`, selon les
[variables officielles](https://code.claude.com/docs/en/env-vars).
La capture conserve son empreinte, pas sa valeur. Le workspace n’est pas déduit
ni remplacé par celui d’un autre compte.

## Capture et effets

Le runner et le CLI reçoivent un environnement remplacé, un HOME privé, un
`CLAUDE_CONFIG_DIR` privé persistant et un répertoire de contexte vide, distinct du
workspace des outils. Les settings utilisateur/projet, plugins externes, mémoire,
connecteurs, tâches d’arrière-plan, workflows et recherche d’outils MCP sont fermés.
La présence d’une configuration système ou d’un ajout externe non qualifié rend
le moteur indisponible. Les messages composés utilisent `verbatimPrompts`, donc
les commandes slash et les mentions de fichiers restent du texte.

Les deux plugins builtin sont désactivés explicitement par leur ID, les agents
builtin par le flag SDK dédié et `doctor` par son flag documenté. Les catalogues
natifs observés de plugins, agents et skills sont vides. Macro vérifie aussi les
commandes builtin restantes, le modèle, le cwd et la provenance MCP contre la
référence qualifiée. Le CLI épinglé a présenté deux catalogues fermés, avec ou
sans `heapdump` et `team-onboarding`. Aucun autre nom n’est accepté et le catalogue
de chaque init doit correspondre à son propre diagnostic ready. Quand aucun outil
n’est exposé, le SDK omet le serveur MCP vide ; Macro exige alors une liste vide.
Avec des outils, un seul serveur SDK Macro connecté est accepté, avec les noms exacts.
Le binaire et ses instructions builtin sont capturés par
empreinte. Ce contrôle ne constitue pas un sandbox système pour un binaire compromis.

Le hook natif corrèle chaque appel au `tool_use_id` du CLI. Un token privé lie le
handler MCP à ce hook et à ses arguments originaux. Le host fixe le contexte,
l’epoch, l’alias et le binding à partir de la capture. Il réutilise ensuite
l’admission, les approbations, la politique, le root réel et l’exécuteur d’outils
Macro. Les répétitions gardent une identité d’invocation stable. Un refus, un
canal perdu, une epoch révoquée ou une corrélation incohérente n’autorise aucun
nouvel effet.

Les arguments et publications exacts voyagent dans des chaînes. Le journal
conserve les publications avant leur validation par la collection AgSDL
existante. Une réponse textuelle libre ne remplace pas cette publication.

## Session, ambiguïté et arrêt

Macro réserve un UUID de session pour chaque instance. Les opérations de session,
d’entrée et de résultat sont inscrites durablement avant l’envoi. L’initialisation
native et les références de résultat sont conservées avant le terminal AgSDL.
Une activation suivante reprend exclusivement cette session. Les instances
restent distinctes ; leur mémoire porte le format `macro-claude-memory/1`.

Un reçu perdu, une session disparue, un profil modifié ou un tour natif incomplet
bloque la reprise. Macro ne crée pas de session de remplacement, ne fork pas et ne
rejoue pas implicitement l’entrée. Après un échec natif non réussi, le profil
refuse aussi une reprise susceptible de relancer un travail interrompu.

Le superviseur Macro possède le runner et ses descendants. Un `result`,
`interrupt` ou `close` du SDK ne prouve pas leur fin. Stop distingue demande,
confirmation physique et état incertain. La collection de réponses et le terminal
attendent le règlement des outils possédés et la fermeture physique requise.
Aucun successeur n’est livré avant cette clôture.

## Vérifications

Les tests ordinaires couvrent SQLite, la continuité, les publications exactes,
les répétitions, les références avant terminal, l’envoi ambigu et les descendants
avec un runner simulé. La commande suivante qualifie le runner original avec une
installation externe réelle et un fournisseur HTTP local simulé, sans inférence :

```sh
node dev/claude-runner-qualification.mjs
```

Elle exige les variables SDK et CLI ci-dessus et écrit ses preuves sous le dossier
temporaire système, ou au chemin `MACRO_CLAUDE_QUALIFICATION_REPORT` explicite.
Les contrôles avec un modèle réel utilisent un profil QA séparé. Dans un
identifiant d’application QA, ils limitent le modèle à `claude-haiku-5-5`, la
sortie à 1024 tokens, les tours au minimum de la limite capturée et de trois,
et `maxBudgetUsd` à 0,05 USD par query. Ce dernier seuil est évalué après usage,
pas comme un plafond absolu de facture. Ces limites QA ne s’appliquent pas aux
profils de production.
