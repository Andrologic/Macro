# Correspondance avec les types Macro

Ce document relie le contrat portable aux types existants. Il ne demande aucun
changement du runtime.

## Projet et tâche

`project.state` reprend `Project.status`. `project.repository_state` reprend
`Project.gitSetupState` : `ready`, `not_git`, `unborn` ou `unknown`. Un projet
`not_git` reste une ressource valide. Son exécution peut utiliser le mode
`direct` d'une cible de tâche.

Une ressource `task` correspond à un seul `Task` ou `CatalogedImplementTask` :

- `ref.task_id` reprend `Task.id` sans ajouter de projet à l'identité ;
- `project_ids` reprend `Task.project_ids`, avec `Task.project_id` comme valeur
  de compatibilité si la liste historique est absente ;
- `context_project_ids` reprend le champ du même nom ;
- chaque entrée `execution_targets` reprend `TaskExecutionTarget.projectId` et
  son `executionMode` figé, `git` ou `direct`.

La ressource filaire est une projection normalisée : `execution_targets` est
toujours présent, même si le champ interne historique est optionnel. Lors de
l'export, Macro reprend d'abord les cibles explicites. À défaut, il synthétise
une cible pour chaque `project_ids` (ou pour `project_id`) en utilisant la même
résolution de mode que l'exécution locale. Si un projet ne peut pas être résolu
sans ambiguïté en `git` ou `direct`, l'export est refusé avec
`validation_failed` ; le service n'invente pas de mode.

Les états `Pending`, `InProgress`, `AwaitingResponse`, `InReview`, `Blocked`,
`Completed` et `Failed` deviennent respectivement `queued`, `running`,
un état d'attente typé, `review_ready`, `blocked`, `completed` et `failed`.
`AwaitingResponse` devient `waiting_decision` quand le questionnaire est la
demande active, `waiting_tool_approval` quand Macro attend l'autorisation
d'un appel d'outil, ou `waiting_reply` pour l'attention `kind: 'reply'` de
`src/services/taskQueueAttention.ts`. Cette dernière n'est pas un questionnaire.

## Réponse simple et projection partielle

Une tâche `waiting_reply` expose `reply_context.conversation_id` quand la
conversation active est connue. Son `prompt` est optionnel et expurgé.
`task.reply` cible la tâche et transmet `payload.conversation_id` et `answer`,
avec sa révision attendue. C revalide l'attente et la conversation, puis utilise
le chemin desktop existant `useChatStore.sendMessage` avec `conversationId`,
`taskId` et `content`. Il ne crée aucun questionnaire artificiel.

Si l'attention ne connaît pas la conversation, la tâche reste `waiting_reply`
avec `projection.missing` contenant `reply_context`. Le client affiche l'attente
sans proposer de réponse distante. `reply_context` et ce marqueur s'excluent.
Ils sont absents des autres états de tâche.

Les tâches historiques restent exportables sans reconstruire leurs runs.
Le type interne `Task` ne porte pas de date de modification. Lorsqu'aucune
date de modification réelle n'est disponible, C omet `task.updated_at` et
publie `task.observed_at`, date réelle d'observation du snapshot courant. Ce
champ ne prétend pas dater une modification historique. C persiste la révision
de projection et l'avance quand le contenu ou l'attente change.
`projection.missing` contient `run_history` lorsque des identités ou dates de
run manquent. C omet ces runs au lieu de fabriquer `run_id`, `created_at`,
`started_at` ou `finished_at`. Un run réellement connu conserve les exigences
du schéma. S'il attend une réponse simple, son état est `waiting_reply` et
`waiting_on` référence sa tâche. Une review sans run ou SHA vérifiables n'est
pas créée ; la tâche conserve `review_ready` et le marqueur `review`.

Une décision active sans run connu utilise une `decisionRef` avec les vrais
`conversation_id` et `assistant_message_id`. C attribue et persiste son
`decision_id` et sa révision à sa première observation. Une date de création
connue reste `created_at` ; sinon `observed_at` indique la première observation
réelle, jamais une date de création supposée. Cette règle vaut aussi pour les
approbations d'outils. Les identités observées restent stables aux redémarrages.

`resolution.resolved_by` conserve l'acteur distant `account_id`, `session_id`,
`device_id` quand il est établi. Une réponse locale observée utilise
`{ "origin": "local" }`, sans exiger de compte relais. Une provenance historique
inconnue utilise `{ "origin": "unknown" }` ; seule cette forme autorise
l'absence de `resolved_at`. Une date connue reste la date réelle, même si
l'acteur est inconnu. Les nouvelles résolutions locales ou distantes portent
toujours leur date réelle. `issued_by` des commandes réseau reste exclusivement
un acteur distant authentifié, jamais une provenance locale ou inconnue.

Un run et ses décisions prolongent l'identité de cette tâche unique. Ils ne sont
pas dupliqués pour chaque projet. Une review Git ajoute `project_id` parce que
ses `base_sha` et `head_sha` appartiennent à un dépôt précis.

## Session et instance

`device_session` correspond à la session du compte sur un appareil. Son
identité contient `account_id` et `session_id`, sans `instance_id`.
`instance_access` relie ensuite cette session à une instance et à ses
permissions. Plusieurs ressources `instance_access` peuvent donc partager la
même session.

## Questionnaire

Une ressource `decision` correspond à un `QuestionnairePayload`. Chaque entrée
`steps` reprend un `QuestionStep` :

- `step_id` reprend directement `QuestionStep.id`, y compris un identifiant
  court comme `scope` ;
- `prompt` reprend le texte de la question ;
- les trois entrées `choices` reprennent le tuple de trois chaînes ;
- `free_text_placeholder` reprend le champ optionnel existant ;
- `free_text_allowed` vaut `true` pour le questionnaire actuel, dont le footer
  accepte toujours une réponse saisie.

La résolution reprend `answersByStepId` et
`QuestionnaireResponseSummary.items` sans inventer d'identifiant de choix.
Chaque entrée contient la chaîne `answer` telle que Macro la stocke. Une égalité
exacte avec l'une des trois chaînes de `choices` désigne un choix ; toute autre
valeur est une réponse libre et exige `free_text_allowed: true`. Cette règle
permet un aller-retour sans perte. Le service valide toutes les étapes avant
d'accepter `decision.resolve` à la révision demandée.

## Approbation d'outil

Une ressource `tool_approval` correspond à un `PendingToolApproval`, sans la
transformer en `QuestionnairePayload` :

- `ref.conversation_id`, `assistant_message_id` et `tool_call_id` reprennent les
  trois identifiants de la demande ; `instance_id` vient de l'adaptateur ;
- `tool_id`, `action_group`, `risk_level`, `is_destructive` et `summary`
  reprennent les champs d'affichage après expurgation ;
- `allowed_scopes` vaut `["once"]` quand `canApproveForConversation` est
  `false`, sinon `["once", "conversation"]` ;
- `ref.workspace_id` et `task_id` sont ajoutés ensemble si la tâche est connue ;
  `run_id` s'ajoute seulement si le run est connu ; une conversation autonome
  omet les trois ;
- `recoveryState: "interrupted"` devient l'état `interrupted` et ne peut pas
  être résolu à distance.

`args`, `detail` et `rememberKey` restent locaux : ils peuvent contenir des
chemins, domaines, commandes ou détails de portée. Macro garde leur
correspondance interne et revalide le contexte courant avant d'accepter la
commande. Les résultats runtime `allow_once` et `allow_conversation` deviennent
`verdict: "approve"` avec `grant_scope: "once"` ou `"conversation"`. Le résultat
`deny` devient `verdict: "deny"` avec un motif optionnel. `expired` est un état,
pas une troisième décision utilisateur.

Un run suspendu par cette demande utilise `waiting_tool_approval` et reprend la
même référence dans `waiting_on`. Les champs instance, workspace, tâche et run
de cette référence sont alors obligatoires et identiques à ceux du run. Un run
attendant un questionnaire conserve `waiting_decision` et une `decisionRef`.

Une review Git n'utilise pas cette ressource. Elle reste liée à ses SHA et son
verdict ne déclenche aucune opération Git implicite.
