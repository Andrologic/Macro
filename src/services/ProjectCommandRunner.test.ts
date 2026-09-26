import { expect, it, mock } from 'bun:test';
import { ProjectCommandRunner, type ProjectCommandSession } from './ProjectCommandRunner';

it.each(['completed', 'failed', 'cancelled', 'restored-disconnected'])('reads immediate %s completion without subscribing', async (status) => {
  const session = { id: 'pty', status, hasLiveSession: false, lastExitCode: 0 };
  const subscribe = mock(() => () => {});
  const runner = new ProjectCommandRunner({ start: async () => session, read: () => session, subscribe, close: async () => {} }, { reveal: () => {} });
  expect(await runner.waitForCompletion('pty')).toBe(session);
  expect(subscribe).not.toHaveBeenCalled();
});

it.each([true, false])('cleans up when completion/removal occurs during subscribe: %s', async (removed) => {
  let session: ProjectCommandSession | null = { id: 'pty', status: 'running', hasLiveSession: true, lastExitCode: null };
  const unsubscribe = mock(() => {});
  const runner = new ProjectCommandRunner({
    start: async () => { throw new Error('not needed'); },
    read: () => session,
    subscribe: (changed) => {
      session = removed ? null : { id: 'pty', status: 'completed', hasLiveSession: false, lastExitCode: 0 };
      changed();
      return unsubscribe;
    },
    close: async () => {},
  }, { reveal: () => {} });
  expect(await runner.waitForCompletion('pty')).toBe(session);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
