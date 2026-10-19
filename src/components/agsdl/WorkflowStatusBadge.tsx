import { CircleHelp, Square } from 'lucide-react';
import type { NativeCardActivation, NativeCardState } from '../../services/agsdl/executionView';
import type { TrackedTask } from '../../services/agsdl/taskTracking';
import type { TaskStatusIndicatorState } from '../../services/taskStatusPresentation';
import { TaskStatusIndicator } from '../tasks/TaskStatusIndicator';
import { useAgsdlTranslation } from './useAgsdlTranslation';

const nativeTaskStates: Partial<Record<NativeCardState, TaskStatusIndicatorState>> = {
  queued: 'idle_prompt', active: 'running', completed: 'completed', failed: 'failed', approval: 'awaiting_response',
};

export function WorkflowStatusBadge({ task, native }: { task?: TrackedTask; native?: NativeCardActivation }) {
  const { t } = useAgsdlTranslation();
  if (!task && !native) return null;
  // A linked task carries user-facing states such as review or a pending reply.
  // Retain native uncertainty and Stop states even if its task has not caught up.
  const nativeAlert = native && (native.partial || ['uncertain', 'stopRequested', 'stopped'].includes(native.state));
  const state = nativeAlert ? undefined
    : native?.state === 'approval' ? 'awaiting_response'
    : native?.state === 'failed' ? 'failed'
    : task?.state ?? (native && nativeTaskStates[native.state]);
  const label = state ? t(`agsdl.taskState.${state}`)
    : t(native?.partial ? 'agsdl.execution.partial' : `agsdl.execution.state.${native?.state}`);
  const description = [task?.title, label].filter(Boolean).join(' · ');
  return <span
    className={`agsdl-node-task ${state ? `agsdl-task-${state}` : `agsdl-native-status-${native?.partial ? 'partial' : native?.state}`}`}
    role="img" aria-label={label} title={description}
  >
    {state ? <TaskStatusIndicator state={state} layout="graph" size={14} />
      : native?.state === 'stopped' && !native.partial ? <Square size={14} aria-hidden="true" />
      : <CircleHelp size={14} aria-hidden="true" />}
  </span>;
}
