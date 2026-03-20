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

export const countUnreadNotificationItems = (items: NotificationCenterItem[]): number =>
  items.filter((item) => item.readAt === null).length;
