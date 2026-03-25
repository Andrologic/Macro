import { describe, expect, it, mock } from 'bun:test';
import {
  createLoadAppVersion,
  DEFAULT_APP_VERSION,
  normalizeAppVersion,
} from './appVersion';

describe('appVersion', () => {
  it('normalizes empty values to the provided fallback', () => {
    expect(normalizeAppVersion('', '1.2.3')).toBe('1.2.3');
    expect(normalizeAppVersion('   ', '1.2.3')).toBe('1.2.3');
    expect(normalizeAppVersion(undefined, DEFAULT_APP_VERSION)).toBe(DEFAULT_APP_VERSION);
  });

  it('returns the build fallback outside of Tauri', async () => {
    const loadAppVersion = createLoadAppVersion({
      fallbackVersion: '1.2.3',
      isTauriEnvironment: () => false,
      getRuntimeVersion: mock(async () => '9.9.9'),
    });

    expect(await loadAppVersion()).toBe('1.2.3');
  });

  it('returns the runtime version inside Tauri', async () => {
    const loadAppVersion = createLoadAppVersion({
      fallbackVersion: '1.2.3',
      isTauriEnvironment: () => true,
      getRuntimeVersion: mock(async () => '2.0.0-beta.1'),
    });

    expect(await loadAppVersion()).toBe('2.0.0-beta.1');
  });

  it('falls back when the runtime lookup fails', async () => {
    const loadAppVersion = createLoadAppVersion({
      fallbackVersion: '1.2.3',
      isTauriEnvironment: () => true,
      getRuntimeVersion: mock(async () => {
        throw new Error('runtime unavailable');
      }),
    });

    expect(await loadAppVersion()).toBe('1.2.3');
  });
});
