import { describe, expect, it } from 'bun:test';
import type { SpeechProviderConfig } from '../../types';
import { resolveSpeechProviderSelection } from './providerSelection';

const provider = (id: string, isEnabled = true): SpeechProviderConfig => ({
  id,
  name: id,
  providerType: 'openai-compatible',
  baseUrl: 'https://speech.example.com/v1',
  model: 'test',
  hasStoredApiKey: false,
  isEnabled,
  isLocal: false,
  createdAt: 'now',
  updatedAt: 'now',
});

describe('resolveSpeechProviderSelection', () => {
  const providers = [provider('openai-speech'), provider('andrologic-speech')];

  it('selects Andrologic when no user choice was persisted', () => {
    expect(resolveSpeechProviderSelection(providers)).toBe('andrologic-speech');
  });

  it('preserves an available persisted user choice', () => {
    expect(resolveSpeechProviderSelection(providers, 'openai-speech')).toBe('openai-speech');
  });

  it('falls back to Andrologic when the persisted provider is unavailable', () => {
    expect(resolveSpeechProviderSelection(providers, 'missing')).toBe('andrologic-speech');
  });
});
