import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_NOTIFICATION_CHANNEL_MODES,
  getAllowedNotificationChannelModes,
  sanitizeNotificationChannelModes,
} from './notificationChannels';

describe('notificationChannels', () => {
  it('returns defaults when the persisted payload is invalid', () => {
    expect(sanitizeNotificationChannelModes(null)).toEqual(
      DEFAULT_NOTIFICATION_CHANNEL_MODES
    );
  });

  it('keeps valid per-category channel modes and falls back missing values', () => {
    expect(
      sanitizeNotificationChannelModes({
        task_attention_required: 'toast',
        task_run_completed: 'desktop',
        task_completed: 'invalid',
      })
    ).toEqual({
      ...DEFAULT_NOTIFICATION_CHANNEL_MODES,
      task_attention_required: 'toast',
      task_run_completed: 'desktop',
    });
  });

  it('repairs disallowed desktop-only modes for actionable categories', () => {
    expect(
      sanitizeNotificationChannelModes({
        task_attention_required: 'desktop',
      })
    ).toEqual(DEFAULT_NOTIFICATION_CHANNEL_MODES);
  });

  it('exposes only allowed per-category channel modes', () => {
    expect(getAllowedNotificationChannelModes('task_attention_required')).toEqual([
      'off',
      'toast',
      'both',
    ]);
    expect(getAllowedNotificationChannelModes('git_sync_completed')).toEqual([
      'off',
      'toast',
      'desktop',
      'both',
    ]);
  });
});
