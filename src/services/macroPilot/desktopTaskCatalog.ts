import type { DesktopStorePorts } from './desktopStorePorts';
import type { CatalogedImplementTask } from '../implementTaskCatalog';

/** The branch-qualified catalog shared by desktop UI and Pilot supervision.
 * The workspace fallback only covers its current plan, not all Architect plans. */
type PilotTask = CatalogedImplementTask & { task_source: 'architect' | 'plan_finalization' | 'standalone' };
// The current Pilot protocol has no AgSDL source or native-workflow action contract.
// Keep those tasks with their workflow owner instead of mislabeling them as legacy tasks.
export const desktopPilotTasks = (ports: DesktopStorePorts) => ports.tasks().tasks
  .filter((task): task is PilotTask => task.task_source !== 'agsdl');
