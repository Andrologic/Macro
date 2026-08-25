import { describe, expect, it } from 'bun:test';
import {
  getAnchoredArchitectMenuPosition,
  getPointerArchitectMenuPosition,
} from './architectProjectNavigatorMenu';

describe('architect project navigator menu positioning', () => {
  it('opens the creation menu below and centered on its trigger when space allows', () => {
    expect(getAnchoredArchitectMenuPosition(
      { top: 100, right: 180, bottom: 132, left: 100, width: 80, height: 32 },
      { width: 240, height: 150 },
      { width: 1200, height: 800 },
    )).toEqual({ top: 138, left: 20 });
  });

  it('opens above a trigger near the bottom and keeps the menu inside the viewport', () => {
    expect(getAnchoredArchitectMenuPosition(
      { top: 700, right: 1180, bottom: 732, left: 1100, width: 80, height: 32 },
      { width: 240, height: 180 },
      { width: 1200, height: 760 },
    )).toEqual({ top: 514, left: 952 });
  });

  it('clamps a pointer context menu away from viewport edges', () => {
    expect(getPointerArchitectMenuPosition(
      { x: 1190, y: 750 },
      { width: 208, height: 124 },
      { width: 1200, height: 760 },
    )).toEqual({ top: 628, left: 984 });
  });
});
