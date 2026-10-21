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
