import { create } from 'zustand';
import { Task } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';

interface TaskStore {
  tasks: Task[];
  isLoading: boolean;
  lastError: string | null;
  setTasks: (tasks: Task[]) => void;
  initialize: () => Promise<void>;
}

export const useTaskStore = create<TaskStore>((set) => ({
  tasks: [],
  isLoading: false,
  lastError: null,

  setTasks: (tasks) => set({ tasks }),

  initialize: async () => {
    set({ isLoading: true, lastError: null });
    try {
      const { tasks } = await services.listTasks();
      set({ tasks, isLoading: false });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },
}));
