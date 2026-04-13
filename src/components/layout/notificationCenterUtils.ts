import type { NotificationCenterItem } from '../../stores/useNotificationCenterStore';

export interface NotificationCenterAnchorRect {
  top: number;
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
  const left = Math.min(
    Math.max(NOTIFICATION_CENTER_PANEL_MARGIN, unclampedLeft),
    Math.max(NOTIFICATION_CENTER_PANEL_MARGIN, viewport.width - width - NOTIFICATION_CENTER_PANEL_MARGIN)
  );
  const maxHeight = Math.min(
    NOTIFICATION_CENTER_PANEL_MAX_HEIGHT,
    Math.max(160, Math.floor(Math.min(viewport.height * 0.6, anchorRect.top - NOTIFICATION_CENTER_PANEL_MARGIN - NOTIFICATION_CENTER_PANEL_GAP)))
  );

  return {
    top: Math.round(anchorRect.top - NOTIFICATION_CENTER_PANEL_GAP),
    left: Math.round(left),
    width: Math.round(width),
    maxHeight,
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

const isSameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const isSameHour = (left: Date, right: Date): boolean =>
  isSameDay(left, right) && left.getHours() === right.getHours();

export const groupNotificationCenterItemsByDate = (
  items: NotificationCenterItem[],
  options?: {
    now?: number;
    locale?: string;
    labels?: {
      lessThanMinute?: string;
      thisHour?: string;
      today?: string;
      yesterday?: string;
    };
  }
): NotificationCenterTimeGroup[] => {
  const nowTimestamp = options?.now ?? Date.now();
  const locale = options?.locale ?? 'en';
  const labels = {
    lessThanMinute: options?.labels?.lessThanMinute ?? 'Less than a minute ago',
    thisHour: options?.labels?.thisHour ?? 'This hour',
    today: options?.labels?.today ?? 'Today',
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

    if (deltaMs < 60 * 1000) {
      groupId = 'less-than-minute';
      label = labels.lessThanMinute;
    } else if (isSameHour(parsed, nowDate)) {
      groupId = 'this-hour';
      label = labels.thisHour;
    } else if (itemDayStart === todayStart) {
      groupId = 'today';
      label = labels.today;
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
