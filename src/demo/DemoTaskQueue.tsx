import TaskQueue from '../components/tasks/TaskQueue';
import { DEMO_MACRO_LIBRARY_ID } from './macroBlueprintLibrary';
const excludedProjectIds = [DEMO_MACRO_LIBRARY_ID];

export default function DemoTaskQueue() {
  return <TaskQueue excludedProjectIds={excludedProjectIds} />;
}
