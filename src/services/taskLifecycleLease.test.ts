import { describe, expect, it, mock } from 'bun:test';
import { createTaskLifecycleLease } from './taskLifecycleLease';

const fixture = () => {
  const native = {
    isTauriAvailable: () => true,
    workspaceAcquireTaskLifecycleLock: mock(async () => 'lease'),
    workspaceRenewTaskLifecycleLock: mock(async (): Promise<void> => undefined),
    workspaceReleaseTaskLifecycleLock: mock(async () => undefined),
  };
  let heartbeat: () => void = () => undefined;
  const stop = mock(() => undefined);
  const reportFailure = mock(() => undefined);
  const lock = createTaskLifecycleLease({ native,
    startHeartbeat: (renew) => { heartbeat = renew; return stop; }, reportFailure });
  return { native, lock, stop, reportFailure, tick: () => heartbeat() };
};

describe('task lifecycle lease', () => {
  it('holds the project lease for the operation and releases it after failure', async () => {
    const f = fixture();
    await expect(f.lock('task', async (lease) => {
      expect(lease).toBe('lease');
      expect(f.native.workspaceReleaseTaskLifecycleLock).not.toHaveBeenCalled();
      throw new Error('Denied operation');
    }, ['/repo'])).rejects.toThrow('Denied operation');
    expect(f.native.workspaceAcquireTaskLifecycleLock).toHaveBeenCalledWith('task', ['/repo']);
    expect(f.native.workspaceReleaseTaskLifecycleLock).toHaveBeenCalledWith('lease');
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it('waits for an in-flight renewal before releasing the lease', async () => {
    const f = fixture();
    let finishRenew!: () => void;
    f.native.workspaceRenewTaskLifecycleLock.mockImplementation(async () => new Promise<void>((resolve) => { finishRenew = resolve; }));
    const operation = f.lock('task', async () => { f.tick(); f.tick(); return 'done'; });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.native.workspaceRenewTaskLifecycleLock).toHaveBeenCalledTimes(1);
    expect(f.native.workspaceReleaseTaskLifecycleLock).not.toHaveBeenCalled();
    finishRenew();
    expect(await operation).toBe('done');
    expect(f.native.workspaceReleaseTaskLifecycleLock).toHaveBeenCalledTimes(1);
  });
  it('reports a failed release without hiding the original operation error', async () => {
    const f = fixture();
    f.native.workspaceReleaseTaskLifecycleLock.mockRejectedValue(new Error('Release failed'));
    await expect(f.lock('task', async () => { throw new Error('Operation failed'); })).rejects.toThrow('Operation failed');
    expect(f.reportFailure).toHaveBeenCalledTimes(1);
  });
});
