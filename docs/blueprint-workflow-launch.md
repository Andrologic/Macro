# Blueprint workflow launch

The former 0.2 `blueprintWorkflowService` was retired with the old scheduler.
Blueprint copies preserve supported source bytes and provenance through the
existing Architect metadata workflow. New systems use AgSDL 0.4.0. Opening a 0.2
source reports an unsupported edition and performs no automatic conversion.

The product launches 0.3.0 and 0.4.0 through durable intents in `useAgsdlExecutionStore`.
`workflowAgentTasks` projects retained native agent instances into Macro tasks;
it neither dispatches another chat nor creates a separate workflow journal.
See [AgSDL in Macro](agsdl-030.md) for the supported product contracts.
