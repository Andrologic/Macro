import type { DesktopStorePorts } from './desktopStorePorts';

/** The branch-qualified catalog shared by desktop UI and Pilot supervision.
 * The workspace fallback only covers its current plan, not all Architect plans. */
export const desktopPilotTasks = (ports: DesktopStorePorts) => ports.tasks().tasks;
