export interface ArchitectMenuAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface ArchitectMenuPosition {
  top: number;
  left: number;
}

interface ArchitectMenuSize {
  width: number;
  height: number;
}

interface ArchitectMenuViewport {
  width: number;
  height: number;
}

const MENU_MARGIN = 8;
const MENU_GAP = 6;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

export const getAnchoredArchitectMenuPosition = (
  anchor: ArchitectMenuAnchorRect,
  menu: ArchitectMenuSize,
  viewport: ArchitectMenuViewport,
): ArchitectMenuPosition => {
  const roomBelow = viewport.height - anchor.bottom - MENU_MARGIN;
  const roomAbove = anchor.top - MENU_MARGIN;
  const openAbove = roomBelow < menu.height + MENU_GAP && roomAbove > roomBelow;
  const preferredLeft = anchor.left + (anchor.width - menu.width) / 2;

  return {
    top: openAbove
      ? clamp(anchor.top - menu.height - MENU_GAP, MENU_MARGIN, viewport.height - menu.height - MENU_MARGIN)
      : clamp(anchor.bottom + MENU_GAP, MENU_MARGIN, viewport.height - menu.height - MENU_MARGIN),
    left: clamp(preferredLeft, MENU_MARGIN, viewport.width - menu.width - MENU_MARGIN),
  };
};

export const getPointerArchitectMenuPosition = (
  pointer: { x: number; y: number },
  menu: ArchitectMenuSize,
  viewport: ArchitectMenuViewport,
): ArchitectMenuPosition => ({
  top: clamp(pointer.y, MENU_MARGIN, viewport.height - menu.height - MENU_MARGIN),
  left: clamp(pointer.x, MENU_MARGIN, viewport.width - menu.width - MENU_MARGIN),
});
