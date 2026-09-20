import { create } from 'zustand';
import type { WorkspaceSession, WorkspaceViewId } from '../domains/shell/workspace';

interface WorkspaceSessionState {
  readonly selectedViewId: WorkspaceViewId;
}
interface WorkspaceSessionsStore {
  /** View preferences only. Task, plan, conversation and worktree state retain their domain owner. */
  sessions: Readonly<Record<string, WorkspaceSessionState>>;
  selectView: (session: WorkspaceSession, viewId: WorkspaceViewId) => void;
  removeSession: (sessionId: string) => void;
}

export const useWorkspaceSessionsStore = create<WorkspaceSessionsStore>((set) => ({
  sessions: {},
  selectView: (session, selectedViewId) => set((state) => ({
    sessions: { ...state.sessions, [session.id]: { selectedViewId } },
  })),
  removeSession: (sessionId) => set((state) => {
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { sessions };
  }),
}));
