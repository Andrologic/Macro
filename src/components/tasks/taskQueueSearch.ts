import type { ImplementTask } from '../../stores/useTaskStore';
import { matchesLocalSearchQuery } from '../../services/localModeSearch';

export const filterTasksByQuery = (
  tasks: ImplementTask[],
  searchQuery: string,
): ImplementTask[] => tasks.filter((task) =>
  matchesLocalSearchQuery(searchQuery, [task.title, task.description])
);
