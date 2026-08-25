import { describe, expect, it } from 'bun:test';
import {
  clampUiZoomLevel,
  getEffectiveUiZoomScale,
} from './uiZoom';

describe('uiZoom', () => {
  it('returns 1 for auto mode regardless of saved level', () => {
    expect(getEffectiveUiZoomScale('auto', 0.75)).toBe(1);
    expect(getEffectiveUiZoomScale('auto', 1.5)).toBe(1);
    expect(getEffectiveUiZoomScale('auto', 2)).toBe(1);
  });

  it('returns the clamped override level in override mode', () => {
    expect(getEffectiveUiZoomScale('override', 1)).toBe(1);
    expect(getEffectiveUiZoomScale('override', 1.5)).toBe(1.5);
    expect(getEffectiveUiZoomScale('override', 0.5)).toBe(0.75);
    expect(getEffectiveUiZoomScale('override', 3)).toBe(2);
  });

  it('clamps invalid zoom values to the supported range', () => {
    expect(clampUiZoomLevel(Number.NaN)).toBe(1);
    expect(clampUiZoomLevel(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampUiZoomLevel(0.74)).toBe(0.75);
    expect(clampUiZoomLevel(2.01)).toBe(2);
  });
});
