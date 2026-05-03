import type { NotificationCenterItem } from '../../stores/useNotificationCenterStore';

export interface NotificationCenterAnchorRect {
  top: number;
  bottom?: number;
  right: number;
}

export interface NotificationCenterViewport {
  width: number;
  height: number;
}

export interface NotificationCenterPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: 'above' | 'below';
}

export interface NotificationCenterTimeGroup {
  id: string;
  label: string;
  items: NotificationCenterItem[];
}

export const NOTIFICATION_CENTER_PANEL_WIDTH = 380;
export const NOTIFICATION_CENTER_PANEL_MARGIN = 8;
export const NOTIFICATION_CENTER_PANEL_GAP = 10;
export const NOTIFICATION_CENTER_PANEL_MAX_HEIGHT = 520;

export const calculateNotificationCenterPosition = (
  anchorRect: NotificationCenterAnchorRect,
  viewport: NotificationCenterViewport
): NotificationCenterPosition => {
  const availableWidth = Math.max(0, viewport.width - NOTIFICATION_CENTER_PANEL_MARGIN * 2);
  const width = Math.min(NOTIFICATION_CENTER_PANEL_WIDTH, availableWidth);
  const unclampedLeft = anchorRect.right - width;
  const maxLeft = Math.max(
    NOTIFICATION_CENTER_PANEL_MARGIN,
    viewport.width - width - NOTIFICATION_CENTER_PANEL_MARGIN
  );
  const left = Math.min(
    Math.max(NOTIFICATION_CENTER_PANEL_MARGIN, unclampedLeft),
    maxLeft
  );
  const availableAbove = Math.max(
    0,
    anchorRect.top - NOTIFICATION_CENTER_PANEL_MARGIN - NOTIFICATION_CENTER_PANEL_GAP
  );
  const anchorBottom = anchorRect.bottom ?? anchorRect.top;
  const availableBelow = Math.max(
    0,
    viewport.height - anchorBottom - NOTIFICATION_CENTER_PANEL_MARGIN - NOTIFICATION_CENTER_PANEL_GAP
  );
  const placement = availableAbove >= 160 || availableAbove >= availableBelow ? 'above' : 'below';
  const availableHeight = placement === 'above' ? availableAbove : availableBelow;
  const maxHeight = Math.min(
    NOTIFICATION_CENTER_PANEL_MAX_HEIGHT,
    Math.max(120, Math.floor(Math.min(viewport.height * 0.6, availableHeight)))
  );

  return {
    top: Math.round(
      placement === 'above'
        ? anchorRect.top - NOTIFICATION_CENTER_PANEL_GAP
        : anchorBottom + NOTIFICATION_CENTER_PANEL_GAP
    ),
    left: Math.round(left),
    width: Math.round(width),
    maxHeight,
    placement,
  };
};

export const formatNotificationRelativeTime = (
  timestamp: string,
  now = Date.now()
): string => {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) {
    return '';
  }

  const deltaSeconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (deltaSeconds < 5) return 'now';
  if (deltaSeconds < 60) return `${deltaSeconds}s`;

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h`;

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d`;
};

const startOfDay = (value: Date): Date =>
  new Date(value.getFullYear(), value.getMonth(), value.getDate());

const formatNotificationRelativeGroupLabel = (
  unit: Intl.RelativeTimeFormatUnit,
  value: number,
  locale: string
): string =>
  new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
    style: 'short',
  }).format(value, unit);

export const groupNotificationCenterItemsByDate = (
  items: NotificationCenterItem[],
  options?: {
    now?: number;
    locale?: string;
    labels?: {
      lessThanMinute?: string;
      yesterday?: string;
    };
  }
): NotificationCenterTimeGroup[] => {
  const nowTimestamp = options?.now ?? Date.now();
  const locale = options?.locale ?? 'en';
  const labels = {
    lessThanMinute: options?.labels?.lessThanMinute ?? 'Less than a minute ago',
    yesterday: options?.labels?.yesterday ?? 'Yesterday',
  };
  const nowDate = new Date(nowTimestamp);
  const todayStart = startOfDay(nowDate).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const dateFormatterSameYear = new Intl.DateTimeFormat(locale, {
    month: 'long',
    day: 'numeric',
  });
  const dateFormatterWithYear = new Intl.DateTimeFormat(locale, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const groups: NotificationCenterTimeGroup[] = [];
  const groupIndexById = new Map<string, number>();

  for (const item of items) {
    const parsed = new Date(item.createdAt);
    const timestamp = parsed.getTime();

    if (!Number.isFinite(timestamp)) {
      continue;
    }

    const deltaMs = Math.max(0, nowTimestamp - timestamp);
    const itemDayStart = startOfDay(parsed).getTime();
    let groupId: string;
    let label: string;

    if (itemDayStart === todayStart && deltaMs < 60 * 1000) {
      groupId = 'less-than-minute';
      label = labels.lessThanMinute;
    } else if (itemDayStart === todayStart) {
      const deltaMinutes = Math.max(1, Math.floor(deltaMs / (60 * 1000)));

      if (deltaMinutes < 60) {
        groupId = `today:minute:${deltaMinutes}`;
        label = formatNotificationRelativeGroupLabel('minute', -deltaMinutes, locale);
      } else {
        const deltaHours = Math.max(1, Math.floor(deltaMinutes / 60));
        groupId = `today:hour:${deltaHours}`;
        label = formatNotificationRelativeGroupLabel('hour', -deltaHours, locale);
      }
    } else if (itemDayStart === yesterdayStart) {
      groupId = 'yesterday';
      label = labels.yesterday;
    } else {
      const sameYear = parsed.getFullYear() === nowDate.getFullYear();
      groupId = `date:${itemDayStart}`;
      label = sameYear
        ? dateFormatterSameYear.format(parsed)
        : dateFormatterWithYear.format(parsed);
    }

    const existingGroupIndex = groupIndexById.get(groupId);
    if (existingGroupIndex !== undefined) {
      groups[existingGroupIndex]?.items.push(item);
      continue;
    }

    groupIndexById.set(groupId, groups.length);
    groups.push({
      id: groupId,
      label,
      items: [item],
    });
  }

  return groups;
};

export const countUnreadNotificationItems = (items: NotificationCenterItem[]): number =>
  items.filter((item) => item.readAt === null).length;
