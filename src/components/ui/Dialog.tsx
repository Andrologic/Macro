import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const openDialogs = new Set<HTMLElement>();
const backgroundAttributes = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();

const getFocusableElements = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('hidden')
  );

const synchronizeBackgroundInertness = (): void => {
  if (typeof document === 'undefined') return;

  const topmostDialog = Array.from(openDialogs).at(-1) ?? null;
  for (const child of Array.from(document.body.children).filter(
    (candidate): candidate is HTMLElement => candidate instanceof HTMLElement
  )) {
    const shouldBeInert = openDialogs.size > 0 && child !== topmostDialog;
    if (shouldBeInert) {
      if (!backgroundAttributes.has(child)) {
        backgroundAttributes.set(child, {
          inert: child.hasAttribute('inert'),
          ariaHidden: child.getAttribute('aria-hidden'),
        });
      }
      child.setAttribute('inert', '');
      child.setAttribute('aria-hidden', 'true');
    } else {
      const previous = backgroundAttributes.get(child);
      if (previous?.inert) child.setAttribute('inert', '');
      else child.removeAttribute('inert');
      if (previous?.ariaHidden === null) child.removeAttribute('aria-hidden');
      else if (previous) child.setAttribute('aria-hidden', previous.ariaHidden);
    }
  }

  if (openDialogs.size === 0) backgroundAttributes.clear();
};

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  backdropClassName?: string;
  panelClassName?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/** A portal dialog with keyboard focus management and an inert application background. */
export const Dialog: React.FC<DialogProps> = ({
  title,
  onClose,
  children,
  backdropClassName = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4',
  panelClassName = 'w-full',
  initialFocusRef,
}) => {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    openDialogs.add(root);
    synchronizeBackgroundInertness();

    const focusInitialElement = () => {
      if (openDialogs.size === 0 || Array.from(openDialogs).at(-1) !== root) return;
      (initialFocusRef?.current ?? getFocusableElements(panel)[0] ?? panel).focus();
    };
    queueMicrotask(focusInitialElement);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (Array.from(openDialogs).at(-1) !== root) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusableElements = getFocusableElements(panel);
      if (focusableElements.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      openDialogs.delete(root);
      synchronizeBackgroundInertness();
      previousFocusRef.current?.focus();
    };
  }, [initialFocusRef]);

  return createPortal(
    <div ref={rootRef} data-macro-dialog-root className={backdropClassName}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={panelClassName}
      >
        <h2 id={titleId} className="sr-only">{title}</h2>
        {children}
      </div>
    </div>,
    document.body
  );
};

export const hasOpenDialog = (): boolean =>
  typeof document !== 'undefined' && (
    document.querySelector('[data-macro-dialog-root]') !== null ||
    document.querySelector('[role="dialog"][aria-modal="true"]') !== null
  );
