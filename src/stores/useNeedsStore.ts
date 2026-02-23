import { create } from 'zustand';
import type { Need } from '../types';
import { useAppStore } from './useAppStore';
import { getGitFlowBaseBranch, saveArchitectPlanNeeds } from '../services/architectPlanService';

const persistPlanNeeds = (planId: string | null | undefined, needs: Need[]): void => {
  if (!planId) return;
  void saveArchitectPlanNeeds(getGitFlowBaseBranch(), planId, needs.filter((need) => need.planId === planId));
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
  replaceNeedsForPlan: (planId: string, needs: Need[]) => void;
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
    const selectedProjectId = appState.selectedProjectId;
    const activePlanId = appState.activeArchitectPlanId;
    const newNeed: Need = {
      ...needData,
      id,
      planId: needData.planId ?? activePlanId ?? undefined,
      projectId: needData.projectId ?? selectedProjectId ?? undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    set((state) => {
      const nextNeeds = [...state.needs, newNeed];
      persistPlanNeeds(newNeed.planId, nextNeeds);
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
        persistPlanNeeds(updatedNeed?.planId, nextNeeds);
        return nextNeeds;
      })(),
    }));
  },

  deleteNeed: (id) => {
    set((state) => ({
      needs: (() => {
        const deletedNeed = state.needs.find((need) => need.id === id);
        const nextNeeds = state.needs.filter((n) => n.id !== id);
        persistPlanNeeds(deletedNeed?.planId, nextNeeds);
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

  replaceNeedsForPlan: (planId, nextNeeds) => {
    const normalizedNeeds = nextNeeds.map((need) => ({ ...need, planId }));
    set((state) => {
      const others = state.needs.filter((need) => need.planId !== planId);
      const selectedStillExists = normalizedNeeds.some((need) => need.id === state.selectedNeedId);
      return {
        needs: [...others, ...normalizedNeeds],
        selectedNeedId: selectedStillExists ? state.selectedNeedId : null,
      };
    });
    persistPlanNeeds(planId, normalizedNeeds);
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
