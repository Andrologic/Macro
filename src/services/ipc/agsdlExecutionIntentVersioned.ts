import type {
ExecutionCloseIntentRequest,
ExecutionIntentKey,
ExecutionReadIntentsRequest,
ExecutionStageIntentRequest,
PublicExecutionIntent,
} from '../../types/generated/ipc';
import { invoke } from '../tauriRuntimeBridge';

/** Native admission accepts only the supported 0.3 profile. */
export function stageExecutionIntentVersioned(request: ExecutionStageIntentRequest): Promise<PublicExecutionIntent> {
  return invoke('execution_stage_intent', { request });
}

export function readExecutionIntentsVersioned(request: ExecutionReadIntentsRequest): Promise<PublicExecutionIntent[]> {
  return invoke('execution_read_intents', { request });
}

export function readExecutionIntentVersioned(key: ExecutionIntentKey): Promise<PublicExecutionIntent | null> {
  return invoke('execution_read_intent', { key });
}

export function submitExecutionIntentVersioned(key: ExecutionIntentKey): Promise<PublicExecutionIntent> {
  return invoke('execution_submit_intent', { key });
}

export function closeExecutionIntentVersioned(request: ExecutionCloseIntentRequest): Promise<PublicExecutionIntent> {
  return invoke('execution_close_intent', { request });
}
