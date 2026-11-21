import { useSyncExternalStore } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { retainedRunValue030 } from '../../services/agsdl/runtimeProjection030';
import { isWorkflowAgentTask, sameWorkflowSource030, subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030 } from '../../services/workflowAgentTasks';
import { WorkflowRunView030 } from '../architect/ArchitectStrategyPanel';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';

export default function OperateCenter() {
  const { t } = useAgsdlTranslation();
  const selected = useAppStore(state => state.selectedTaskId);
  const task = useTaskStore(state => state.tasks.find(item => item.id === selected && isWorkflowAgentTask(item)));
  const registrations = useSyncExternalStore(subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030);
  const ref = task?.workflow_execution;
  const bundle = ref && registrations.find(item => {
    const read = item.access.getSnapshot().runs[ref.systemStartId];
    const inspection = read && retainedRunValue030(read);
    return inspection && inspection.capture.systemStartId === ref.systemStartId &&
      inspection.state.scope.systemStartId === ref.systemStartId && sameWorkflowSource030(inspection.capture.source, ref.source) &&
      sameWorkflowSource030(inspection.state.scope.source, ref.source) &&
      inspection.state.instances.some(instance => instance.id === ref.agentInstanceId);
  });
  if (bundle && task && ref) return <WorkflowRunView030 key={task.id} bundle={bundle}
    target={{ scope: { systemStartId: ref.systemStartId, source: ref.source }, conversationId: bundle.scope.conversationId }}
    initialInstanceId={ref.agentInstanceId} />;
  return <p role="status" className="m-auto p-4 text-sm text-muted-foreground">{t(ref ? 'agsdl.shell030.exactUnavailable' : 'agsdl.run030.selectRun')}</p>;
}
