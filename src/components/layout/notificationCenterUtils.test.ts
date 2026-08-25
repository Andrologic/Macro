import { describe, expect, it } from 'bun:test';
import type { NotificationCenterItem } from '../../stores/useNotificationCenterStore';
import {
  calculateNotificationCenterPosition,
  groupNotificationCenterItemsByDate,
} from './notificationCenterUtils';

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
  it('keeps the popover inside narrow viewport bounds', () => {
    expect(
      calculateNotificationCenterPosition(
        { top: 720, bottom: 752, right: 240 },
        { width: 320, height: 800 }
      )
    ).toEqual({
      top: 710,
      left: 8,
      width: 304,
      maxHeight: 480,
      placement: 'above',
    });
  });

  it('places the popover below the anchor when there is not enough room above', () => {
    expect(
      calculateNotificationCenterPosition(
        { top: 48, bottom: 80, right: 380 },
        { width: 420, height: 800 }
      )
    ).toEqual({
      top: 90,
      left: 8,
      width: 380,
      maxHeight: 480,
      placement: 'below',
    });
  });

  it('groups notification items into one linear time scale', () => {
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
        id: 'today:minute:25',
        label: '25 min. ago',
        items: [items[1]],
      },
      {
        id: 'today:hour:3',
        label: '3 hr. ago',
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

  it('skips invalid dates and groups future timestamps as recent', () => {
    const now = new Date('2026-04-13T12:30:00.000Z').getTime();
    const items = [
      buildItem('invalid', 'not-a-date'),
      buildItem('future', '2026-04-13T12:35:00.000Z'),
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
        items: [items[1]],
      },
    ]);
  });
});
