import { create } from 'zustand';
import type { Need } from '../types';

interface NeedsState {
  needs: Need[];
  selectedNeedId: string | null;
  
  // Actions
  addNeed: (need: Omit<Need, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateNeed: (id: string, updates: Partial<Need>) => void;
  deleteNeed: (id: string) => void;
  selectNeed: (id: string | null) => void;
  clearNeeds: () => void;
  
  // Helpers
  getNeed: (id: string) => Need | undefined;
}

// Initial mock needs for testing
const MOCK_NEEDS: Need[] = [
  {
    id: 'need-1',
    title: 'User Authentication',
    description: 'Users must be able to sign up and log in using email/password.',
    category: 'functional',
    status: 'identified',
    priority: 'high',
    tags: ['auth', 'security'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'need-2',
    title: 'Mobile Responsiveness',
    description: 'The interface must work seamlessly on mobile devices.',
    category: 'ux',
    status: 'validated',
    priority: 'medium',
    tags: ['responsive', 'mobile'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
];

export const useNeedsStore = create<NeedsState>((set, get) => ({
  needs: MOCK_NEEDS,
  selectedNeedId: null,

  addNeed: (needData) => {
    const id = crypto.randomUUID();
    const newNeed: Need = {
      ...needData,
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    set((state) => ({
      needs: [...state.needs, newNeed],
      selectedNeedId: id // Auto-select new needs? Maybe.
    }));
    
    return id;
  },

  updateNeed: (id, updates) => {
    set((state) => ({
      needs: state.needs.map((n) => 
        n.id === id 
          ? { ...n, ...updates, updatedAt: new Date().toISOString() } 
          : n
      ),
    }));
  },

  deleteNeed: (id) => {
    set((state) => ({
      needs: state.needs.filter((n) => n.id !== id),
      selectedNeedId: state.selectedNeedId === id ? null : state.selectedNeedId,
    }));
  },

  selectNeed: (id) => {
    set({ selectedNeedId: id });
  },

  clearNeeds: () => {
    set({ needs: [], selectedNeedId: null });
  },

  getNeed: (id) => {
    return get().needs.find((n) => n.id === id);
  },
}));
