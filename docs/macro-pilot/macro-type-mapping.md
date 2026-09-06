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

Les états `Pending`, `InProgress`, `AwaitingResponse`, `InReview`, `Blocked`,
`Completed` et `Failed` deviennent respectivement `queued`, `running`,
`waiting_decision`, `review_ready`, `blocked`, `completed` et `failed`.

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

- `step_id` reprend `QuestionStep.id` ;
- `prompt` reprend le texte de la question ;
- les trois entrées `choices` reprennent le tuple de trois chaînes ;
- `free_text_placeholder` reprend le champ optionnel existant ;
- `free_text_allowed` vaut `true` pour le questionnaire actuel, dont le footer
  accepte toujours une réponse saisie.

La résolution reprend `answersByStepId` et
`QuestionnaireResponseSummary.items`. Chaque réponse indique si elle correspond
à un choix connu ou à un texte libre. Le service valide toutes les étapes avant
d'accepter `decision.resolve` à la révision demandée.
