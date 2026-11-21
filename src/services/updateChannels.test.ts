import { describe, expect, test } from 'bun:test';
import {
  normalizeUpdateChannel,
} from './updateChannels';

describe('update channels', () => {
  test('normalizes unknown persisted values to stable', () => {
    expect(normalizeUpdateChannel('preview')).toBe('preview');
    expect(normalizeUpdateChannel('nightly')).toBe('stable');
    expect(normalizeUpdateChannel(null)).toBe('stable');
  });

});
