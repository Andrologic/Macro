import { describe, expect, it } from 'bun:test';
import type { NotificationCenterItem } from '../../stores/useNotificationCenterStore';
import { groupNotificationCenterItemsByDate } from './notificationCenterUtils';

const buildItem = (
  id: string,
  createdAt: string
): NotificationCenterItem => ({
  id,
  level: 'info',
  variant: 'informational',
  title: id,
  createdAt,
  readAt: null,
});

describe('notificationCenterUtils', () => {
  it('groups notification items by recent time buckets and older calendar dates', () => {
    const now = new Date('2026-04-13T12:30:00.000Z').getTime();
    const items = [
      buildItem('just-now', '2026-04-13T12:29:40.000Z'),
      buildItem('this-hour', '2026-04-13T12:05:00.000Z'),
      buildItem('today', '2026-04-13T09:00:00.000Z'),
      buildItem('yesterday', '2026-04-12T18:00:00.000Z'),
      buildItem('older', '2026-04-10T14:00:00.000Z'),
      buildItem('last-year', '2025-12-22T14:00:00.000Z'),
    ];

    expect(
      groupNotificationCenterItemsByDate(items, {
        now,
        locale: 'en-US',
      })
    ).toEqual([
      {
        id: 'less-than-minute',
        label: 'Less than a minute ago',
        items: [items[0]],
      },
      {
        id: 'this-hour',
        label: 'This hour',
        items: [items[1]],
      },
      {
        id: 'today',
        label: 'Today',
        items: [items[2]],
      },
      {
        id: 'yesterday',
        label: 'Yesterday',
        items: [items[3]],
      },
      {
        id: `date:${new Date('2026-04-10T00:00:00.000Z').getTime()}`,
        label: 'April 10',
        items: [items[4]],
      },
      {
        id: `date:${new Date('2025-12-22T00:00:00.000Z').getTime()}`,
        label: 'December 22, 2025',
        items: [items[5]],
      },
    ]);
  });
});
