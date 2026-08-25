import { describe, expect, test } from 'bun:test';
import {
  normalizeUpdateChannel,
  shouldAllowChannelDowngrade,
  updaterTargetForChannel,
} from './updateChannels';

describe('update channels', () => {
  test('normalizes unknown persisted values to stable', () => {
    expect(normalizeUpdateChannel('preview')).toBe('preview');
    expect(normalizeUpdateChannel('nightly')).toBe('stable');
    expect(normalizeUpdateChannel(null)).toBe('stable');
  });

  test('namespaces native updater targets by channel', () => {
    expect(updaterTargetForChannel('preview', 'darwin-aarch64'))
      .toBe('preview-darwin-aarch64');
  });

  test('allows a downgrade only when leaving a prerelease for stable', () => {
    expect(shouldAllowChannelDowngrade('stable', '0.2.0-nightly.20260825.1')).toBe(true);
    expect(shouldAllowChannelDowngrade('stable', '0.2.0')).toBe(false);
    expect(shouldAllowChannelDowngrade('preview', '0.2.0-nightly.20260825.1')).toBe(false);
  });
});
