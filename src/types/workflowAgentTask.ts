import type { AgentInstanceId, SystemStartId, SourceRevision, ActivationId, Sequence } from './agsdlExecution';

export type WorkflowAgentTaskState = 'idle' | 'queued' | 'active' | 'approval' | 'uncertain' |
  'stopRequested' | 'stopped' | 'completed' | 'failed';
export interface WorkflowAgentTaskReference {
  systemStartId: SystemStartId;
  source: SourceRevision;
  agentInstanceId: AgentInstanceId;
  agentName: string;
  cursor: Sequence;
  state: WorkflowAgentTaskState;
  activationIds: ActivationId[];
  interactionRequired: boolean;
  stale?: boolean;
}
