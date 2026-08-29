import { expect, test } from 'bun:test';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { createBrowserRuntimeFetch, type RuntimeInvoke } from './tauriHttp';

test('sérialise une réponse HTTP et libère son corps lors d’une annulation', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridgeInvoke: RuntimeInvoke = async <T>(
    command: string,
    args?: InvokeArgs,
  ): Promise<T> => {
    calls.push({ command, args });
    switch (command) {
      case 'plugin:http|fetch':
        return 7 as T;
      case 'plugin:http|fetch_send':
        return {
          status: 200,
          statusText: 'OK',
          url: 'https://example.test/data',
          headers: [['content-type', 'text/plain']],
          rid: 9,
        } as T;
      case 'plugin:http|fetch_read_body':
        return [65, 1] as T;
      default:
        return undefined as T;
    }
  };
  const fetch = createBrowserRuntimeFetch(bridgeInvoke);

  const response = await fetch('https://example.test/data');
  await expect(response.text()).resolves.toBe('A');

  const controller = new AbortController();
  const abortedResponse = await fetch('https://example.test/data', {
    signal: controller.signal,
  });
  controller.abort();
  await expect(abortedResponse.text()).rejects.toThrow('Request cancelled');
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(calls).toContainEqual({
    command: 'plugin:http|fetch_cancel_body',
    args: { rid: 9 },
  });

  const completedController = new AbortController();
  const completedResponse = await fetch('https://example.test/data', {
    signal: completedController.signal,
  });
  await expect(completedResponse.text()).resolves.toBe('A');
  const cancellationsBeforeLateAbort = calls.filter(({ command }) =>
    command.startsWith('plugin:http|fetch_cancel'),
  ).length;
  completedController.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    calls.filter(({ command }) => command.startsWith('plugin:http|fetch_cancel')).length,
  ).toBe(cancellationsBeforeLateAbort);
});
