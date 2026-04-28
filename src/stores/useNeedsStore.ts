import { create } from 'zustand';
import type { Need } from '../types';
import { useAppStore } from './useAppStore';
import {
  getGitFlowBaseBranch,
  resolveTargetBranch,
  saveArchitectPlanNeeds,
} from '../services/architectPlanService';

const pendingNeedPersistenceByKey = new Map<string, Promise<void>>();

const getNeedPersistenceKey = (targetBranch: string, planId: string): string =>
  `${targetBranch}::${planId}`;

const persistPlanNeeds = (planId: string | null | undefined, needs: Need[]): Promise<void> => {
  if (!planId) return Promise.resolve();

  const appState = useAppStore.getState();
  const activeContext = appState.activePlanContext;
  const targetBranch = (() => {
    if (activeContext && activeContext.id === planId) {
      try {
        return resolveTargetBranch(activeContext.targetBranch);
      } catch {
        return getGitFlowBaseBranch();
      }
    }
    return getGitFlowBaseBranch();
  })();

  const persistenceKey = getNeedPersistenceKey(targetBranch, planId);
  const previous = pendingNeedPersistenceByKey.get(persistenceKey) ?? Promise.resolve();
  const nextNeeds = needs.filter((need) => need.planId === planId);
  const next = previous
    .catch(() => undefined)
    .then(() => saveArchitectPlanNeeds(targetBranch, planId, nextNeeds));

  pendingNeedPersistenceByKey.set(persistenceKey, next);
  next.then(
    () => {
      if (pendingNeedPersistenceByKey.get(persistenceKey) === next) {
        pendingNeedPersistenceByKey.delete(persistenceKey);
      }
    },
    (error) => {
      if (pendingNeedPersistenceByKey.get(persistenceKey) === next) {
        pendingNeedPersistenceByKey.delete(persistenceKey);
      }
      console.warn('Failed to persist architect plan needs:', error);
    }
  );

  return next;
};

const normalizeNeedsForPlan = (
  planId: string,
  needs: Need[],
  fallbackGroupId?: string | null
): Need[] =>
  needs.map((need) => ({
    ...need,
    planId,
    groupId: need.groupId ?? fallbackGroupId ?? undefined,
  }));

const applyNeedsForPlan = (
  state: Pick<NeedsState, 'needs' | 'selectedNeedId'>,
  planId: string,
  normalizedNeeds: Need[]
) => {
  const others = state.needs.filter((need) => need.planId !== planId);
  const selectedStillExists = normalizedNeeds.some((need) => need.id === state.selectedNeedId);
  return {
    needs: [...others, ...normalizedNeeds],
    selectedNeedId: selectedStillExists ? state.selectedNeedId : null,
  };
};

interface NeedsState {
  needs: Need[];
  selectedNeedId: string | null;
  
  // Actions
  addNeed: (need: Omit<Need, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateNeed: (id: string, updates: Partial<Need>) => void;
  deleteNeed: (id: string) => void;
  selectNeed: (id: string | null) => void;
  clearNeeds: () => void;
  beginArchitectPlanSwitch: (planId: string | null) => void;
  hydrateNeedsForPlan: (planId: string, needs: Need[]) => void;
  replaceNeedsForPlan: (planId: string, needs: Need[]) => void;
  flushPendingPersistence: (planId?: string | null) => Promise<void>;
  getNeedsForPlan: (planId: string) => Need[];
  getActivePlanNeeds: () => Need[];
  
  // Helpers
  getNeed: (id: string) => Need | undefined;
}

export const useNeedsStore = create<NeedsState>((set, get) => ({
  needs: [],
  selectedNeedId: null,

  addNeed: (needData) => {
    const id = crypto.randomUUID();
    const appState = useAppStore.getState();
    const selectedGroupId = appState.selectedGroupId;
    const activePlanId = appState.activeArchitectPlanId;
    const newNeed: Need = {
      ...needData,
      id,
      planId: needData.planId ?? activePlanId ?? undefined,
      groupId: needData.groupId ?? selectedGroupId ?? undefined,
      projectId: needData.projectId ?? undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    set((state) => {
      const nextNeeds = [...state.needs, newNeed];
      void persistPlanNeeds(newNeed.planId, nextNeeds);
      return {
        needs: nextNeeds,
        selectedNeedId: id,
      };
    });
    
    return id;
  },

  updateNeed: (id, updates) => {
    set((state) => ({
      needs: (() => {
        const nextNeeds = state.needs.map((n) =>
          n.id === id
            ? { ...n, ...updates, updatedAt: new Date().toISOString() }
            : n
        );
        const updatedNeed = nextNeeds.find((need) => need.id === id);
        void persistPlanNeeds(updatedNeed?.planId, nextNeeds);
        return nextNeeds;
      })(),
    }));
  },

  deleteNeed: (id) => {
    set((state) => ({
      needs: (() => {
        const deletedNeed = state.needs.find((need) => need.id === id);
        const nextNeeds = state.needs.filter((n) => n.id !== id);
        void persistPlanNeeds(deletedNeed?.planId, nextNeeds);
        return nextNeeds;
      })(),
      selectedNeedId: state.selectedNeedId === id ? null : state.selectedNeedId,
    }));
  },

  selectNeed: (id) => {
    set({ selectedNeedId: id });
  },

  clearNeeds: () => {
    set({ needs: [], selectedNeedId: null });
  },

  beginArchitectPlanSwitch: (planId) => {
    set((state) => {
      if (!state.selectedNeedId) {
        return state;
      }

      const selectedNeed = state.needs.find(
        (need) => need.id === state.selectedNeedId
      );
      if (!selectedNeed) {
        return { selectedNeedId: null };
      }

      if (!planId || selectedNeed.planId !== planId) {
        return { selectedNeedId: null };
      }

      return state;
    });
  },

  hydrateNeedsForPlan: (planId, nextNeeds) => {
    const selectedGroupId = useAppStore.getState().selectedGroupId;
    const normalizedNeeds = normalizeNeedsForPlan(planId, nextNeeds, selectedGroupId);
    set((state) => applyNeedsForPlan(state, planId, normalizedNeeds));
  },

  replaceNeedsForPlan: (planId, nextNeeds) => {
    const selectedGroupId = useAppStore.getState().selectedGroupId;
    const normalizedNeeds = normalizeNeedsForPlan(planId, nextNeeds, selectedGroupId);
    set((state) => {
      return applyNeedsForPlan(state, planId, normalizedNeeds);
    });
    void persistPlanNeeds(planId, normalizedNeeds);
  },

  flushPendingPersistence: async (planId) => {
    const pending = Array.from(pendingNeedPersistenceByKey.entries())
      .filter(([key]) => !planId || key.endsWith(`::${planId}`))
      .map(([, promise]) => promise);

    if (pending.length === 0) {
      return;
    }

    await Promise.all(pending);
  },

  getNeedsForPlan: (planId) => {
    return get().needs.filter((need) => need.planId === planId);
  },

  getActivePlanNeeds: () => {
    const activePlanId = useAppStore.getState().activeArchitectPlanId;
    if (!activePlanId) return [];
    return get().needs.filter((need) => need.planId === activePlanId);
  },

  getNeed: (id) => {
    return get().needs.find((n) => n.id === id);
  },
}));
