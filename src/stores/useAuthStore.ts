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

// Mock user for development
const mockUser: User = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Demo User',
  avatar: undefined,
  preferences: {
    theme: 'dark',
    language: 'en',
    notifications: true,
    emailUpdates: false,
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const mockSession: Session = {
  user: mockUser,
  token: 'mock-token-' + Date.now(),
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
};

export const useAuthStore = create<AuthStore>((set, get) => ({
  authStatus: 'loading',
  user: null,
  session: null,
  isLoading: false,
  lastError: null,

  setLoading: (loading) => set({ isLoading: loading }),

  setLastError: (error) => set({ lastError: error }),

  login: async (credentials: AuthCredentials) => {
    set({ isLoading: true, lastError: null });
    try {
      // Mock login - in production, this would call an IPC service
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      // Simple mock validation
      if (credentials.email && credentials.password) {
        set({
          authStatus: 'authenticated',
          user: mockUser,
          session: mockSession,
          isLoading: false,
        });
      } else {
        throw new Error('Invalid credentials');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      set({
        authStatus: 'unauthenticated',
        user: null,
        session: null,
        isLoading: false,
        lastError: message,
      });
      throw error;
    }
  },

  logout: async () => {
    set({ isLoading: true, lastError: null });
    try {
      // Mock logout - in production, this would call an IPC service
      await new Promise((resolve) => setTimeout(resolve, 300));
      
      set({
        authStatus: 'unauthenticated',
        user: null,
        session: null,
        isLoading: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Logout failed';
      set({
        isLoading: false,
        lastError: message,
      });
      throw error;
    }
  },

  register: async (credentials: AuthCredentials & { name: string }) => {
    set({ isLoading: true, lastError: null });
    try {
      // Mock registration - in production, this would call an IPC service
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      const newUser: User = {
        ...mockUser,
        email: credentials.email,
        name: credentials.name,
        id: 'user-' + Date.now(),
      };

      const newSession: Session = {
        user: newUser,
        token: 'mock-token-' + Date.now(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };

      set({
        authStatus: 'authenticated',
        user: newUser,
        session: newSession,
        isLoading: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed';
      set({
        authStatus: 'unauthenticated',
        user: null,
        session: null,
        isLoading: false,
        lastError: message,
      });
      throw error;
    }
  },

  updatePreferences: async (preferences: Partial<UserPreferences>) => {
    set({ isLoading: true, lastError: null });
    try {
      // Mock update - in production, this would call an IPC service
      await new Promise((resolve) => setTimeout(resolve, 300));
      
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
    try {
      // Mock session check - in production, this would call an IPC service
      await new Promise((resolve) => setTimeout(resolve, 200));
      
      // For mock purposes, check if we have a session in localStorage
      const savedSession = localStorage.getItem('mockSession');
      if (savedSession) {
        const parsedSession: Session = JSON.parse(savedSession);
        set({
          authStatus: 'authenticated',
          user: parsedSession.user,
          session: parsedSession,
          isLoading: false,
        });
      } else {
        set({
          authStatus: 'unauthenticated',
          user: null,
          session: null,
          isLoading: false,
        });
      }
    } catch (error) {
      set({
        authStatus: 'unauthenticated',
        user: null,
        session: null,
        isLoading: false,
      });
    }
  },
}));

// Subscribe to session changes to persist to localStorage
useAuthStore.subscribe(
  (state) => {
    if (state.session) {
      localStorage.setItem('mockSession', JSON.stringify(state.session));
    } else {
      localStorage.removeItem('mockSession');
    }
  }
);
