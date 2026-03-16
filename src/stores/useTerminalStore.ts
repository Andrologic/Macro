import { create } from 'zustand';
import * as tauriIpc from '../services/tauriIpc';

interface TerminalStore {
  sessions: Record<string, tauriIpc.TerminalSessionDto>;
  lastSessionIdByProjectId: Record<string, string>;
  upsertSession: (session: tauriIpc.TerminalSessionDto) => tauriIpc.TerminalSessionDto;
  createSession: (params: {
    projectId: string;
    cwd?: string | null;
  }) => Promise<tauriIpc.TerminalSessionDto>;
  runCommand: (params: {
    sessionId: string;
    command: string;
    timeoutMs?: number | null;
  }) => Promise<tauriIpc.TerminalSessionDto>;
  readSession: (sessionId: string) => Promise<tauriIpc.TerminalSessionDto>;
  killSession: (sessionId: string) => Promise<tauriIpc.TerminalSessionDto>;
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  sessions: {},
  lastSessionIdByProjectId: {},

  upsertSession: (session) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [session.id]: session,
      },
      lastSessionIdByProjectId: {
        ...state.lastSessionIdByProjectId,
        [session.project_id]: session.id,
      },
    }));

    return session;
  },

  createSession: async ({ projectId, cwd }) => {
    const session = await tauriIpc.terminalCreateSession({
      projectId,
      cwd: cwd ?? null,
    });
    set((state) => ({
      sessions: {
        ...state.sessions,
        [session.id]: session,
      },
      lastSessionIdByProjectId: {
        ...state.lastSessionIdByProjectId,
        [session.project_id]: session.id,
      },
    }));
    return session;
  },

  runCommand: async ({ sessionId, command, timeoutMs }) => {
    const session = await tauriIpc.terminalRun({
      sessionId,
      command,
      timeoutMs: timeoutMs ?? null,
    });
    set((state) => ({
      sessions: {
        ...state.sessions,
        [session.id]: session,
      },
      lastSessionIdByProjectId: {
        ...state.lastSessionIdByProjectId,
        [session.project_id]: session.id,
      },
    }));
    return session;
  },

  readSession: async (sessionId) => {
    const session = await tauriIpc.terminalRead(sessionId);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [session.id]: session,
      },
      lastSessionIdByProjectId: {
        ...state.lastSessionIdByProjectId,
        [session.project_id]: session.id,
      },
    }));
    return session;
  },

  killSession: async (sessionId) => {
    const session = await tauriIpc.terminalKill(sessionId);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [session.id]: session,
      },
      lastSessionIdByProjectId: {
        ...state.lastSessionIdByProjectId,
        [session.project_id]: session.id,
      },
    }));
    return session;
  },
}));
