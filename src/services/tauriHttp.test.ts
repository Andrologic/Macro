import { expect, test } from 'bun:test';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { createBrowserRuntimeFetch, createTauriFetch, type RuntimeInvoke } from './tauriHttp';

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
  expect(calls.find(({ command }) => command === 'plugin:http|fetch')?.args).toMatchObject({
    clientConfig: { maxRedirections: 0 },
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

test('désactive les redirections HTTP même si l’appelant en demande', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridgeInvoke: RuntimeInvoke = async <T>(command: string, args?: InvokeArgs): Promise<T> => {
    calls.push({ command, args });
    if (command === 'plugin:http|fetch') return 1 as T;
    if (command === 'plugin:http|fetch_send') return {
      status: 307,
      statusText: 'Temporary Redirect',
      url: 'https://provider.example/v1/chat',
      headers: [['location', 'https://other.example/collect']],
      rid: 2,
    } as T;
    return undefined as T;
  };

  const response = await createBrowserRuntimeFetch(bridgeInvoke)(
    'https://provider.example/v1/chat',
    { method: 'POST', body: 'sensitive request', maxRedirections: 10 },
  );

  expect(response.status).toBe(307);
  expect(calls.filter(({ command }) => command === 'plugin:http|fetch')).toHaveLength(1);
  expect(calls[0]?.args).toMatchObject({
    clientConfig: { maxRedirections: 0, method: 'POST' },
  });
});

test('impose la même limite aux transports natif et navigateur', async () => {
  const received: Array<{ transport: string; maxRedirections: number | undefined }> = [];
  const nativeFetch = async (_input: RequestInfo | URL, init?: RequestInit & { maxRedirections?: number }) => {
    received.push({ transport: 'native', maxRedirections: init?.maxRedirections });
    return new Response(null, { status: 204 });
  };
  const bridgeFetch = async (_input: RequestInfo | URL, init?: RequestInit & { maxRedirections?: number }) => {
    received.push({ transport: 'bridge', maxRedirections: init?.maxRedirections });
    return new Response(null, { status: 204 });
  };

  await createTauriFetch(nativeFetch, bridgeFetch, () => false)(
    'https://provider.example/v1/chat', { maxRedirections: 10 },
  );
  await createTauriFetch(nativeFetch, bridgeFetch, () => true)(
    'https://provider.example/v1/chat', { maxRedirections: 10 },
  );

  expect(received).toEqual([
    { transport: 'native', maxRedirections: 0 },
    { transport: 'bridge', maxRedirections: 0 },
  ]);
});
