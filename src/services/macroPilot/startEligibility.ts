import type { Task } from '../../types';
import { PilotError } from './protocol';

type StartTask = Pick<Task, 'status' | 'task_source' | 'draft' | 'is_blocked'>;
type StartRejectionCode = 'invalid_reference' | 'unavailable';

export const pilotStartRejection = (task: StartTask | undefined): StartRejectionCode | null => {
  if (!task || task.task_source === 'plan_finalization' || task.draft) return 'invalid_reference';
  if (task.is_blocked || (task.status !== 'Pending' && task.status !== 'Failed')) return 'unavailable';
  return null;
};

// Only the synchronous start eligibility check, before the first effect gate,
// may issue this proof. Ordinary PilotErrors do not prove absence of effects.
export class PilotStartPreflightRejection extends PilotError {
  constructor(code: StartRejectionCode) { super(code); }
}
