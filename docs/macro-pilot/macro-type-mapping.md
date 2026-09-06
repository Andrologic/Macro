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
demande active, ou `waiting_tool_approval` quand Macro attend l'autorisation
d'un appel d'outil.

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
- `ref.workspace_id`, `task_id` et `run_id` sont ajoutés ensemble seulement si
  la conversation appartient à un run connu ; une conversation autonome les
  omet tous ;
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
