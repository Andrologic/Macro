import { useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DialogContext } from '../ui/Dialog';

export interface GraphPopupAction { label: string; icon: ReactNode; run: () => void }

/** Registered with the owning dialog so menus also work in an expanded graph. */
export function WorkflowGraphPopup({ anchor, position, actions, label, children, onClose, id, onMouseEnter, onMouseLeave }: {
  anchor: Element; position?: { left: number; top: number }; actions?: GraphPopupAction[];
  label: string; children?: ReactNode; onClose: () => void; id?: string; onMouseEnter?: () => void; onMouseLeave?: () => void;
}) {
  const dialog = useContext(DialogContext);
  const popup = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  const [placed, setPlaced] = useState({ left: 0, top: 0 });
  const isMenu = Boolean(actions);
  const restoreFocus = useCallback(() => {
    const target = anchor.matches('button, [tabindex]') ? anchor : anchor.querySelector('button, [tabindex]');
    if (target instanceof HTMLElement || target instanceof SVGElement) target.focus();
  }, [anchor]);
  useLayoutEffect(() => {
    const element = popup.current;
    if (!element) return;
    const rect = anchor.getBoundingClientRect();
    const size = element.getBoundingClientRect();
    const left = position?.left ?? rect.right + 10;
    const top = position?.top ?? rect.top;
    setPlaced({
      left: Math.max(8, Math.min(!position && left + size.width > window.innerWidth - 8 ? rect.left - size.width - 10 : left, window.innerWidth - size.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - size.height - 8)),
    });
    const unregisterPortal = dialog?.registerPortal(element);
    const dismiss = (restore = false) => { close.current(); if (restore && anchor.isConnected) restoreFocus(); };
    const unregisterEscape = dialog?.registerEscapeHandler(() => dismiss(true));
    const pointer = (event: PointerEvent) => { if (!element.contains(event.target as Node) && (isMenu || !anchor.contains(event.target as Node))) dismiss(); };
    const scroll = (event: Event) => { if (!element.contains(event.target as Node)) dismiss(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(true); return; }
      if (!isMenu) return;
      if (event.key === 'Tab') { dismiss(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const items = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[next]?.focus();
    };
    const resize = () => dismiss();
    const anotherPopup = (event: Event) => { if ((event as CustomEvent).detail !== element) dismiss(); };
    document.dispatchEvent(new CustomEvent('macro:graph-popup-open', { detail: element }));
    document.addEventListener('macro:graph-popup-open', anotherPopup);
    const observer = new MutationObserver(() => { if (element.hasAttribute('inert')) dismiss(); });
    observer.observe(element, { attributes: true, attributeFilter: ['inert'] });
    if (isMenu) element.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    // Window capture runs before the dialog's Escape handler.
    window.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', pointer, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      document.removeEventListener('macro:graph-popup-open', anotherPopup);
      unregisterEscape?.(); unregisterPortal?.();
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [anchor, position, isMenu, dialog, restoreFocus]); // Actions stay current through React handlers.
  return createPortal(<div ref={popup} id={id} role={actions ? 'menu' : 'tooltip'} aria-label={label}
    className={actions ? 'agsdl-graph-menu' : 'agsdl-block-preview'}
    style={{ ...placed, zIndex: Math.max(80, (dialog?.zIndex ?? 0) + 1) }}
    onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onPointerDown={event => event.stopPropagation()}>
    {actions ? actions.map(action => <button key={action.label} type="button" role="menuitem" onClick={event => {
      event.stopPropagation(); close.current(); restoreFocus(); action.run();
    }}>{action.icon}<span>{action.label}</span></button>) : children}
  </div>, document.body);
}
