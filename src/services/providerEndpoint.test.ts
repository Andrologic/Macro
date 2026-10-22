import { describe, expect, it } from 'bun:test';
import { assertSecureProviderEndpoint, readBoundedProviderError } from './providerEndpoint';

describe('provider endpoint security', () => {
  it('allows HTTPS and local HTTP, and rejects remote HTTP', () => {
    expect(() => assertSecureProviderEndpoint('https://provider.example.test/v1')).not.toThrow();
    expect(() => assertSecureProviderEndpoint('http://localhost:11434/v1')).not.toThrow();
    expect(() => assertSecureProviderEndpoint('http://127.0.0.1:11434/v1')).not.toThrow();
    expect(() => assertSecureProviderEndpoint('http://[::1]:11434/v1')).not.toThrow();
    expect(() => assertSecureProviderEndpoint('http://provider.example.test/v1')).toThrow();
    expect(() => assertSecureProviderEndpoint('http://192.168.1.5/v1')).toThrow();
    expect(() => assertSecureProviderEndpoint('https://user:secret@provider.example.test/v1')).toThrow();
  });

  it('bounds provider error response bodies', async () => {
    const response = new Response('x'.repeat(64 * 1024), { status: 500 });
    const text = await readBoundedProviderError(response);
    expect(text.length).toBeLessThanOrEqual(16 * 1024 + ' [truncated]'.length);
    expect(text.endsWith('[truncated]')).toBe(true);
  });

  it('times out when a provider never finishes its error body', async () => {
    const response = new Response(new ReadableStream({ start() {} }), { status: 500 });
    await expect(readBoundedProviderError(response, 1)).rejects.toThrow('timed out');
  });
});

describe('bounded error response ownership', () => {
  for (const phase of ['truncation', 'timeout'] as const) {
    it(`waits for physical cleanup on ${phase} and preserves a missing receipt`, async () => {
      let release!: () => void;
      let cancelled!: () => void;
      const cleanup = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { cancelled = resolve; });
      const { StreamStopUnconfirmedError } = await import('./ai/streamCancellation');
      const owner = new StreamStopUnconfirmedError('Synthetic missing cleanup receipt');
      const response = new Response(new ReadableStream({
        start(controller) {
          if (phase === 'truncation') controller.enqueue(new Uint8Array(32 * 1024));
        },
        async cancel() { cancelled(); await cleanup; throw owner; },
      }), { status: 500 });
      let ended = false;
      const pending = readBoundedProviderError(response, phase === 'timeout' ? 1 : 1_000);
      void pending.then(() => { ended = true; }, () => { ended = true; });
      await started;
      await Promise.resolve();
      expect(ended).toBe(false);
      release();
      await expect(pending).rejects.toBe(owner);
    });
  }
});
