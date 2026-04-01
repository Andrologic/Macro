export const DEFAULT_UI_ZOOM_SCALE = 1;
export const MIN_UI_ZOOM_SCALE = 0.75;
export const MAX_UI_ZOOM_SCALE = 2;

export function clampUiZoomLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return DEFAULT_UI_ZOOM_SCALE;
  }

  return Math.min(MAX_UI_ZOOM_SCALE, Math.max(MIN_UI_ZOOM_SCALE, level));
}

export function getEffectiveUiZoomScale(
  mode: 'auto' | 'override',
  level: number
): number {
  return mode === 'override' ? clampUiZoomLevel(level) : DEFAULT_UI_ZOOM_SCALE;
}
