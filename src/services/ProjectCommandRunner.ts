/** Project commands use visible PTY sessions, never the non-interactive agent terminal. */
export interface ProjectCommandRequest {
  purpose: 'task' | 'worktree_setup';
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  cwd: string;
  command: string;
  reveal: boolean;
  beforeEffect?: () => Promise<void>;
  expectedBranch?: string | null;
}

export interface ProjectCommandSession {
  id: string;
  status: string;
  hasLiveSession: boolean;
  lastExitCode: number | null;
}

export interface ProjectCommandExecutionPort {
  start(request: ProjectCommandRequest): Promise<ProjectCommandSession>;
  read(id: string): ProjectCommandSession | null;
  subscribe(changed: () => void): () => void;
  close(id: string): Promise<void>;
}

export interface ProjectCommandPresentationPort {
  reveal(id: string): void;
}

export const isFinalProjectCommand = (session: ProjectCommandSession): boolean =>
  ['completed', 'failed', 'error', 'cancelled', 'restored-disconnected'].includes(session.status)
  || (!session.hasLiveSession && session.status !== 'running');

export const isFailedProjectCommand = (session: ProjectCommandSession): boolean =>
  session.status === 'failed' || session.status === 'error'
  || (typeof session.lastExitCode === 'number' && session.lastExitCode !== 0);

export class ProjectCommandRunner {
  constructor(
    private readonly execution: ProjectCommandExecutionPort,
    private readonly presentation: ProjectCommandPresentationPort,
  ) {}

  start(request: ProjectCommandRequest): Promise<ProjectCommandSession> {
    return this.execution.start(request);
  }

  close(id: string): Promise<void> {
    return this.execution.close(id);
  }

  reveal(id: string): void {
    this.presentation.reveal(id);
  }

  /** Subscribe then re-read so completion/removal during subscription cannot be lost. */
  waitForCompletion(id: string, signal?: AbortSignal): Promise<ProjectCommandSession | null> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const cleanup = () => { unsubscribe?.(); signal?.removeEventListener('abort', abort); };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Setup command wait cancelled.'));
      };
      const check = () => {
        const session = this.execution.read(id);
        if (settled || (session && !isFinalProjectCommand(session))) return;
        settled = true;
        cleanup();
        resolve(session);
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      check();
      if (settled) return;
      unsubscribe = this.execution.subscribe(check);
      if (settled) unsubscribe();
      else check();
    });
  }
}
