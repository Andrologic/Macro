import { create } from 'zustand';
import type { User, Session, AuthCredentials, UserPreferences } from '../types';

interface AuthStore {
  authStatus: 'authenticated' | 'unauthenticated' | 'loading';
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  lastError: string | null;
  // Actions
  login: (credentials: AuthCredentials) => Promise<void>;
  logout: () => Promise<void>;
  register: (credentials: AuthCredentials & { name: string }) => Promise<void>;
  updatePreferences: (preferences: Partial<UserPreferences>) => Promise<void>;
  checkSession: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  setLastError: (error: string | null) => void;
}

const AUTH_UNAVAILABLE_MESSAGE =
  'Authentication is not implemented in this runtime.';

const unauthenticatedState = {
  authStatus: 'unauthenticated' as const,
  user: null,
  session: null,
};

type SetAuthStoreState = (state: Partial<AuthStore>) => void;

const rejectAuthUnavailable = (set: SetAuthStoreState): never => {
  const error = new Error(AUTH_UNAVAILABLE_MESSAGE);
  set({
    ...unauthenticatedState,
    isLoading: false,
    lastError: error.message,
  });
  throw error;
};

export const useAuthStore = create<AuthStore>((set, get) => ({
  ...unauthenticatedState,
  isLoading: false,
  lastError: null,

  setLoading: (loading) => set({ isLoading: loading }),

  setLastError: (error) => set({ lastError: error }),

  login: async (_credentials: AuthCredentials) => {
    set({ isLoading: true, lastError: null });
    rejectAuthUnavailable(set);
  },

  logout: async () => {
    set({ isLoading: true, lastError: null });
    set({
      ...unauthenticatedState,
      isLoading: false,
    });
  },

  register: async (_credentials: AuthCredentials & { name: string }) => {
    set({ isLoading: true, lastError: null });
    rejectAuthUnavailable(set);
  },

  updatePreferences: async (preferences: Partial<UserPreferences>) => {
    set({ isLoading: true, lastError: null });
    try {
      const state = get();
      if (!state.user) {
        set({ isLoading: false });
        throw new Error('No authenticated user');
      }

      const updatedUser: User = {
        ...state.user,
        preferences: {
          ...state.user.preferences,
          ...preferences,
        },
        updated_at: new Date().toISOString(),
      };

      set({
        user: updatedUser,
        session: state.session ? { ...state.session, user: updatedUser } : null,
        isLoading: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update preferences';
      set({
        isLoading: false,
        lastError: message,
      });
      throw error;
    }
  },

  checkSession: async () => {
    set({ isLoading: true, lastError: null });
    set({
      ...unauthenticatedState,
      isLoading: false,
    });
  },
}));
