# Blueprint workflow launch

The former 0.2 `blueprintWorkflowService` was retired with the old scheduler.
Blueprint copies preserve supported source bytes and provenance through the
existing Architect metadata workflow. New systems use AgSDL 0.3; opening a 0.2
source reports an unsupported edition and performs no automatic conversion.

The product launches 0.3 through durable intents in `useAgsdlExecutionStore`.
`workflowAgentTasks` projects retained native 0.3 instances into Macro tasks;
it neither dispatches another chat nor creates a separate workflow journal.
See [AgSDL 0.3](agsdl-030.md) for the supported product contracts.
