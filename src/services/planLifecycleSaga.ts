import * as tauriIpc from './tauriIpc';

const SAGA_KEY = 'pendingPlanLifecycles:v1';

export type PlanLifecycleOperation = 'archive' | 'delete';
export type PlanLifecyclePhase = 'prepared' | 'metadata_written' | 'git_cleanup_complete' | 'metadata_commit_pending' | 'metadata_deleted' | 'conversation_cleanup_complete';

export interface PlanLifecycleSaga {
  planId: string;
  branchName: string;
  operation: PlanLifecycleOperation;
  phase: PlanLifecyclePhase;
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export class PlanLifecycleSagaCorruptionError extends Error {
  constructor() {
    super('Le journal du cycle de vie des plans est corrompu. La reprise est bloquée afin de préserver les métadonnées et les ressources Git.');
    this.name = 'PlanLifecycleSagaCorruptionError';
  }
}

const parse = (value: string | null | undefined): PlanLifecycleSaga[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new PlanLifecycleSagaCorruptionError();
    return parsed.map((entry) => {
      const saga = entry as Partial<PlanLifecycleSaga>;
      if (
        !saga || typeof saga.planId !== 'string' || typeof saga.branchName !== 'string' ||
        (saga.operation !== 'archive' && saga.operation !== 'delete') ||
        !['prepared', 'metadata_written', 'git_cleanup_complete', 'metadata_commit_pending', 'metadata_deleted', 'conversation_cleanup_complete'].includes(String(saga.phase)) ||
        typeof saga.createdAt !== 'string' || typeof saga.updatedAt !== 'string'
      ) throw new PlanLifecycleSagaCorruptionError();
      return saga as PlanLifecycleSaga;
    });
  } catch (error) {
    if (error instanceof PlanLifecycleSagaCorruptionError) throw error;
    throw new PlanLifecycleSagaCorruptionError();
  }
};

let tail = Promise.resolve();
const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try { return await operation(); } finally { release(); }
};

export const loadPlanLifecycleSagas = async (): Promise<PlanLifecycleSaga[]> => {
  if (!tauriIpc.isTauriAvailable()) return [];
  return parse((await tauriIpc.dbGetAppSetting(SAGA_KEY))?.value_json);
};

const save = async (sagas: PlanLifecycleSaga[]): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) return;
  await tauriIpc.dbSetAppSetting({ key: SAGA_KEY, valueJson: JSON.stringify(sagas) });
};

export const upsertPlanLifecycleSaga = async (saga: PlanLifecycleSaga): Promise<void> => mutate(async () => {
  const current = await loadPlanLifecycleSagas();
  await save([...current.filter((entry) => entry.planId !== saga.planId || entry.operation !== saga.operation), saga]);
});

export const removePlanLifecycleSaga = async (planId: string, operation: PlanLifecycleOperation): Promise<void> => mutate(async () => {
  const current = await loadPlanLifecycleSagas();
  await save(current.filter((entry) => entry.planId !== planId || entry.operation !== operation));
});
