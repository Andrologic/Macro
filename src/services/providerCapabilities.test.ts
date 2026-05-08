import { describe, expect, it } from 'bun:test';
import { resolveProviderCapabilities } from './providerCapabilities';

describe('resolveProviderCapabilities', () => {
  it('marks OpenCode Go as HTTP-only without local runtime support', () => {
    expect(resolveProviderCapabilities({ providerId: 'opencode-go' })).toMatchObject({
      providerId: 'opencode-go',
      httpOnly: true,
      usesKeyring: true,
      usesLocalRuntime: false,
      supportsModelScan: true,
    });
  });

  it('recognizes OpenCode endpoints even when the provider id is custom', () => {
    expect(
      resolveProviderCapabilities({
        providerId: 'custom',
        baseUrl: 'https://opencode.ai/zen/go/v1',
      })
    ).toMatchObject({
      providerId: 'opencode-go',
      httpOnly: true,
      usesLocalRuntime: false,
    });
  });

  it('keeps Copilot classified as a local runtime provider', () => {
    expect(resolveProviderCapabilities({ providerId: 'copilot' })).toMatchObject({
      providerId: 'copilot',
      httpOnly: false,
      usesLocalRuntime: true,
    });
  });
});
