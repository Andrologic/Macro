import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';
import { hasOpenDialog } from './dialogPresence';

export interface SidebarMenuPosition { left: number; top: number }

export function sidebarMenuPosition(event: React.MouseEvent<HTMLElement>): SidebarMenuPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientX || event.clientY
    ? { left: event.clientX, top: event.clientY }
    : { left: rect.left, top: rect.bottom };
}

export function isSidebarTextInput(target: EventTarget | null): boolean {
  return target instanceof window.Element && Boolean(target.closest('input, textarea, [contenteditable="true"]'));
}

function availableItems(menu: HTMLElement): HTMLElement[] {
  const closedGroups = [...menu.querySelectorAll('details:not([open])')];
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])')]
    .filter(item => !item.closest('[hidden], [inert]') && !closedGroups.some(group => group.contains(item) && item.tagName !== 'SUMMARY'));
}

const MENU_OPEN = 'macro:sidebar-menu-open';

function restoreAfterDialog(target: Element | null) {
  if (!(target instanceof HTMLElement) || !target.isConnected) return;
  const observer = new MutationObserver(() => {
    if (!target.isConnected) { observer.disconnect(); return; }
    if (hasOpenDialog() || target.closest('[inert]')) return;
    observer.disconnect();
    if (document.activeElement === document.body || !document.activeElement?.isConnected) target.focus();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] });
}
interface Props extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onClose'> {
  position: SidebarMenuPosition;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
  menuRef?: React.RefObject<HTMLDivElement | null>;
}

/** A shared popup for sidebar actions, kept outside scrolling and clipped lists. */
export function SidebarMenu({ position, onClose, triggerRef, menuRef, children, className, style, ...props }: Props) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = menuRef ?? localRef;
  const returnFocusRef = useRef<Element | null>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  const [placed, setPlaced] = useState(position);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const place = () => {
      const margin = 8;
      const rect = menu.getBoundingClientRect();
      const next = {
        left: Math.max(margin, Math.min(position.left, window.innerWidth - rect.width - margin)),
        top: Math.max(margin, Math.min(position.top, window.innerHeight - rect.height - margin)),
      };
      setPlaced(current => current.left === next.left && current.top === next.top ? current : next);
    };
    place();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    observer?.observe(menu);
    return () => observer?.disconnect();
  }, [position.left, position.top, children, ref]);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const trigger = triggerRef?.current;
    const returnTarget = trigger ?? document.activeElement;
    returnFocusRef.current = returnTarget;
    // Opening another sidebar menu closes this one, including menus in other trees.
    document.dispatchEvent(new CustomEvent(MENU_OPEN, { detail: menu }));
    const otherMenu = (event: Event) => {
      if ((event as CustomEvent).detail !== menu) close.current();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (menu.contains(event.target) || trigger?.contains(event.target))) return;
      close.current();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      close.current();
    };
    const dismiss = () => close.current();
    const closeForDialog = () => {
      if (!hasOpenDialog()) return;
      restoreAfterDialog(returnTarget);
      close.current();
    };
    const dialogObserver = new MutationObserver(closeForDialog);
    dialogObserver.observe(document.body, { childList: true, subtree: true });
    const keyDown = (event: KeyboardEvent) => {
      if (hasOpenDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close.current();
        if (returnTarget instanceof HTMLElement && returnTarget.isConnected) returnTarget.focus();
        return;
      }
      if (event.key === 'Tab') {
        close.current();
        if (returnTarget instanceof HTMLElement && returnTarget.isConnected) returnTarget.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = availableItems(menu);
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next].focus();
    };
    availableItems(menu)[0]?.focus();
    closeForDialog();
    document.addEventListener(MENU_OPEN, otherMenu);
    document.addEventListener('pointerdown', pointerDown);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', keyDown);
    return () => {
      dialogObserver.disconnect();
      document.removeEventListener(MENU_OPEN, otherMenu);
      document.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', keyDown);
    };
  }, [ref, triggerRef]);

  if (typeof document === 'undefined') return null;
  return createPortal(<div {...props} ref={ref} role="menu"
    className={cn('fixed z-[80] w-52 max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-xl [&_[role^=menuitem]]:focus-visible:bg-accent [&_[role^=menuitem]]:focus-visible:outline-none', className)}
    style={{ ...style, left: placed.left, top: placed.top }}
    onClickCapture={() => { const target = returnFocusRef.current; if (target instanceof HTMLElement && target.isConnected) target.focus(); }}
    onClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    {children}
  </div>, document.body);
}
