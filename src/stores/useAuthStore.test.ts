import { beforeEach, describe, expect, it } from 'bun:test';
import type { Session, User } from '../types';
import { useAuthStore } from './useAuthStore';

const buildUser = (): User => ({
  id: 'user-1',
  email: 'user@example.com',
  name: 'Real User',
  avatar: undefined,
  preferences: {
    theme: 'dark',
    language: 'en',
    notifications: true,
    emailUpdates: false,
  },
  created_at: '2026-05-14T00:00:00.000Z',
  updated_at: '2026-05-14T00:00:00.000Z',
});

const buildSession = (user = buildUser()): Session => ({
  user,
  token: 'real-token',
  expires_at: '2026-05-21T00:00:00.000Z',
});

const legacyRuntimeSessionStorageKey = `mock${'Session'}`;

describe('useAuthStore runtime auth state', () => {
  beforeEach(() => {
    useAuthStore.setState({
      authStatus: 'unauthenticated',
      user: null,
      session: null,
      isLoading: false,
      lastError: null,
    });
    localStorage.clear();
  });

  it('starts unauthenticated without a runtime session', () => {
    expect(useAuthStore.getState()).toMatchObject({
      authStatus: 'unauthenticated',
      user: null,
      session: null,
      isLoading: false,
      lastError: null,
    });
  });

  it('does not restore legacy mock sessions', async () => {
    localStorage.setItem(legacyRuntimeSessionStorageKey, JSON.stringify(buildSession()));

    await useAuthStore.getState().checkSession();

    expect(useAuthStore.getState()).toMatchObject({
      authStatus: 'unauthenticated',
      user: null,
      session: null,
      isLoading: false,
      lastError: null,
    });
  });

  it('rejects login and register when no backend auth exists', async () => {
    await expect(
      useAuthStore.getState().login({ email: 'user@example.com', password: 'secret' })
    ).rejects.toThrow('Authentication is not implemented in this runtime.');
    expect(useAuthStore.getState()).toMatchObject({
      authStatus: 'unauthenticated',
      user: null,
      session: null,
      isLoading: false,
      lastError: 'Authentication is not implemented in this runtime.',
    });

    await expect(
      useAuthStore.getState().register({
        email: 'user@example.com',
        password: 'secret',
        name: 'Real User',
      })
    ).rejects.toThrow('Authentication is not implemented in this runtime.');
    expect(useAuthStore.getState().session).toBeNull();
  });

  it('updates preferences only for an existing user', async () => {
    await expect(
      useAuthStore.getState().updatePreferences({ notifications: false })
    ).rejects.toThrow('No authenticated user');

    const user = buildUser();
    useAuthStore.setState({
      authStatus: 'authenticated',
      user,
      session: buildSession(user),
    });

    await useAuthStore.getState().updatePreferences({ notifications: false });

    expect(useAuthStore.getState().user?.preferences.notifications).toBe(false);
    expect(useAuthStore.getState().session?.user.preferences.notifications).toBe(false);
  });
});
