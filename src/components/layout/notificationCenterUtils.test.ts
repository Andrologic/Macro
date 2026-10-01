import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
  it.each([
    ['America/New_York', '2026-03-08', '2026-03-09'],
    ['America/New_York', '2026-11-01', '2026-11-02'],
    ['Europe/Paris', '2026-03-29', '2026-03-30'],
    ['Europe/Paris', '2026-10-25', '2026-10-26'],
    ['Asia/Tokyo', '2026-03-08', '2026-03-09'],
    ['Asia/Tokyo', '2026-11-01', '2026-11-02'],
  ])('groups the previous civil day in %s after %s', (timezone, yesterday, today) => {
    // Start a separate runtime so TZ cannot affect other tests or cached Intl state.
    const items = [
      buildItem('yesterday-late', `${yesterday}T23:59:50`),
      buildItem('today', `${today}T00:00:10`),
      buildItem('yesterday-early', `${yesterday}T00:00:00`),
      buildItem('invalid', 'not-a-date'),
      buildItem('older', '2025-12-22T12:00:00'),
      buildItem('future', `${today}T23:00:00`),
    ];
    const source = `
      import { groupNotificationCenterItemsByDate } from ${JSON.stringify(new URL('./notificationCenterUtils.ts', import.meta.url).href)};
      const input = JSON.parse(await Bun.stdin.text());
      console.log(JSON.stringify(input.times.map(time => groupNotificationCenterItemsByDate(input.items, {
        now: new Date(time).getTime(), locale: 'en-US',
        labels: { yesterday: 'Hier', lessThanMinute: 'Just now' },
      }))));
    `;
    const child = spawnSync(process.execPath, ['--eval', source], {
      env: { ...process.env, TZ: timezone },
      input: JSON.stringify({
        items,
        times: [`${today}T00:00:20`, `${today}T12:00:00`],
      }),
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    const [atMidnight, atNoon] = JSON.parse(child.stdout);
    const yesterdayGroup = { id: 'yesterday', label: 'Hier', items: [items[0], items[2]] };
    const olderGroup = expect.objectContaining({
      label: 'December 22, 2025', items: [items[4]],
    });
    expect(atMidnight).toEqual([
      yesterdayGroup,
      { id: 'less-than-minute', label: 'Just now', items: [items[1], items[5]] },
      olderGroup,
    ]);
    expect(atNoon).toEqual([
      yesterdayGroup,
      { id: 'today:hour:11', label: '11 hr. ago', items: [items[1]] },
      olderGroup,
      { id: 'less-than-minute', label: 'Just now', items: [items[5]] },
    ]);
  });

});
