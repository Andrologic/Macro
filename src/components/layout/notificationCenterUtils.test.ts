import { describe, expect, it } from 'bun:test';
import {
  NOTIFICATION_CENTER_PANEL_MARGIN,
  NOTIFICATION_CENTER_PANEL_WIDTH,
  calculateNotificationCenterPosition,
  countUnreadNotificationItems,
  formatNotificationRelativeTime,
} from './notificationCenterUtils';

describe('notificationCenterUtils', () => {
  it('anchors the panel above the trigger and clamps it to the viewport', () => {
    const position = calculateNotificationCenterPosition(
      {
        top: 720,
        right: 398,
      },
      {
        width: 400,
        height: 800,
      }
    );

    expect(position.top).toBe(710);
    expect(position.width).toBe(NOTIFICATION_CENTER_PANEL_WIDTH);
    expect(position.left).toBeGreaterThanOrEqual(NOTIFICATION_CENTER_PANEL_MARGIN);
    expect(position.left + position.width).toBeLessThanOrEqual(400 - NOTIFICATION_CENTER_PANEL_MARGIN);
  });

  it('formats recent timestamps into compact relative labels', () => {
    const now = new Date('2026-03-20T12:00:00.000Z').getTime();

    expect(formatNotificationRelativeTime('2026-03-20T11:59:58.000Z', now)).toBe('now');
    expect(formatNotificationRelativeTime('2026-03-20T11:55:00.000Z', now)).toBe('5m');
    expect(formatNotificationRelativeTime('2026-03-20T09:00:00.000Z', now)).toBe('3h');
    expect(formatNotificationRelativeTime('2026-03-17T12:00:00.000Z', now)).toBe('3d');
  });

  it('counts unread items correctly', () => {
    expect(
      countUnreadNotificationItems([
        {
          id: '1',
          level: 'info',
          variant: 'informational',
          title: 'Unread',
          createdAt: '2026-03-20T12:00:00.000Z',
          readAt: null,
        },
        {
          id: '2',
          level: 'error',
          variant: 'informational',
          title: 'Read',
          createdAt: '2026-03-20T11:00:00.000Z',
          readAt: '2026-03-20T11:05:00.000Z',
        },
      ])
    ).toBe(1);
  });
});
