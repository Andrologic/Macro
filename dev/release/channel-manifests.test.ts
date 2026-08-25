import { describe, expect, test } from 'bun:test';
import { createChannelManifests } from './channel-manifests.mjs';
import { UPDATER_TARGETS } from './updater-manifest.mjs';

describe('channel updater manifests', () => {
  test('creates one custom-target manifest per supported platform', () => {
    const platforms = Object.fromEntries(UPDATER_TARGETS.map((target) => [target, {
      url: `https://example.com/${target}`,
      signature: `signature-${target}`,
    }]));
    const manifests = createChannelManifests({ version: '0.2.0', platforms }, 'preview');

    expect(Object.keys(manifests)).toEqual(UPDATER_TARGETS.map((target) => `preview-${target}`));
    expect(manifests['preview-windows-x86_64'].platforms).toEqual({
      'preview-windows-x86_64': platforms['windows-x86_64'],
    });
  });

  test('rejects unsupported channels and incomplete manifests', () => {
    expect(() => createChannelManifests({ platforms: {} }, 'beta')).toThrow('Unsupported');
    expect(() => createChannelManifests({ platforms: {} }, 'stable')).toThrow('windows-x86_64');
  });
});
