import * as tauriIpc from './tauriIpc';
import { toServiceError } from './contracts/errors';
import { devLogger } from '../utils/devLogger';

export interface TaskLifecycleLeasePorts {
  native: Pick<typeof tauriIpc, 'isTauriAvailable' | 'workspaceAcquireTaskLifecycleLock' | 'workspaceRenewTaskLifecycleLock' | 'workspaceReleaseTaskLifecycleLock'>;
  startHeartbeat(callback: () => void): () => void;
  reportFailure(taskId: string, phase: 'renew' | 'release', error: unknown): void;
}

export const createTaskLifecycleLease = (ports: TaskLifecycleLeasePorts) => async <T>(
  taskId: string,
  operation: (leaseId: string | null) => Promise<T>,
  directProjectPaths?: string[],
): Promise<T> => {
  if (!ports.native.isTauriAvailable()) {
    return operation(null);
  }
  const leaseId = await ports.native.workspaceAcquireTaskLifecycleLock(taskId, directProjectPaths);
  let renewalInFlight: Promise<void> | null = null;
  const renewLease = () => {
    if (renewalInFlight) return;
    renewalInFlight = ports.native.workspaceRenewTaskLifecycleLock(leaseId)
      .catch((error) => {
        ports.reportFailure(taskId, 'renew', error);
      })
      .finally(() => {
        renewalInFlight = null;
      });
  };
  const stopHeartbeat = ports.startHeartbeat(renewLease);
  try {
    return await operation(leaseId);
  } finally {
    stopHeartbeat();
    await renewalInFlight;
    await ports.native.workspaceReleaseTaskLifecycleLock(leaseId).catch((error) => {
      ports.reportFailure(taskId, 'release', error);
    });
  }
};

export const withTaskLifecycleLock = createTaskLifecycleLease({
  native: tauriIpc,
  startHeartbeat: (renew) => {
    const interval = globalThis.setInterval(renew, 30_000);
    return () => globalThis.clearInterval(interval);
  },
  reportFailure: (taskId, phase, error) => devLogger.warn(`[tasks] Could not ${phase} the task lifecycle lease.`, {
    taskId, error: toServiceError(error).message,
  }),
});
