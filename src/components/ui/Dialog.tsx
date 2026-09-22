import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface OpenDialogEntry {
  order: number;
  zIndex: number;
  escapeHandlers: Set<EscapeHandler>;
  portals: Set<HTMLElement>;
}

type EscapeHandler = () => boolean | void;

interface DialogContextValue {
  zIndex: number;
  registerEscapeHandler: (handler: EscapeHandler) => () => void;
  registerPortal: (portal: HTMLElement) => () => void;
}

const ParentDialogZIndexContext = createContext<number | null>(null);
export const DialogContext = createContext<DialogContextValue | null>(null);
const openDialogs = new Map<HTMLElement, OpenDialogEntry>();
let nextDialogOrder = 0;
const backgroundAttributes = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();

const getTopmostDialog = (): HTMLElement | null => {
  let topmost: [HTMLElement, OpenDialogEntry] | null = null;
  for (const entry of openDialogs.entries()) {
    if (
      !topmost ||
      entry[1].zIndex > topmost[1].zIndex ||
      (entry[1].zIndex === topmost[1].zIndex && entry[1].order > topmost[1].order)
    ) {
      topmost = entry;
    }
  }
  return topmost?.[0] ?? null;
};

const readDialogZIndex = (className: string): number => {
  let zIndex = 0;
  for (const token of className.split(/\s+/)) {
    const arbitraryMatch = /^z-\[(-?\d+)\]$/.exec(token);
    const scaleMatch = /^z-(-?\d+)$/.exec(token);
    const parsed = arbitraryMatch?.[1] ?? scaleMatch?.[1];
    if (parsed !== undefined) zIndex = Number(parsed);
  }
  return zIndex;
};

const getFocusableElements = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('hidden')
  );

const getDialogFocusableElements = (entry: OpenDialogEntry, panel: HTMLElement): HTMLElement[] => [
  ...getFocusableElements(panel),
  ...Array.from(entry.portals).flatMap(getFocusableElements),
];

const restoreFocusAfterDialogClose = (
  previousFocus: HTMLElement | null,
): void => {
  const topmostDialog = getTopmostDialog();
  if (!topmostDialog) {
    previousFocus?.focus();
    return;
  }

  const topmostEntry = openDialogs.get(topmostDialog);
  const focusBelongsToTopmostDialog = previousFocus && (
    topmostDialog.contains(previousFocus) ||
    Array.from(topmostEntry?.portals ?? []).some((portal) => portal.contains(previousFocus))
  );
  if (focusBelongsToTopmostDialog) {
    previousFocus.focus();
    return;
  }

  const panel = topmostDialog.querySelector<HTMLElement>('[role="dialog"]');
  if (!panel) return;
  (getFocusableElements(panel)[0] ?? panel).focus();
};

const synchronizeBackgroundInertness = (): void => {
  if (typeof document === 'undefined') return;

  const topmostDialog = getTopmostDialog();
  const topmostEntry = topmostDialog ? openDialogs.get(topmostDialog) : undefined;
  for (const child of Array.from(document.body.children).filter(
    (candidate): candidate is HTMLElement => candidate instanceof HTMLElement
  )) {
    const isTopmostPortal = topmostEntry?.portals.has(child) ?? false;
    const shouldBeInert = openDialogs.size > 0 && child !== topmostDialog && !isTopmostPortal;
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
  closeOnBackdropClick?: boolean;
  ariaDescribedBy?: string;
}

/** A portal dialog with keyboard focus management and an inert application background. */
export const Dialog: React.FC<DialogProps> = ({
  title,
  onClose,
  children,
  backdropClassName = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4',
  panelClassName = 'flex w-full justify-center',
  initialFocusRef,
  closeOnBackdropClick = false,
  ariaDescribedBy,
}) => {
  const titleId = useId();
  const [dialogOrder] = useState(() => ++nextDialogOrder);
  const parentDialogZIndex = useContext(ParentDialogZIndexContext);
  const requestedZIndex = readDialogZIndex(backdropClassName);
  const effectiveZIndex = parentDialogZIndex === null
    ? requestedZIndex
    : Math.max(requestedZIndex, parentDialogZIndex + 1);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const escapeHandlersRef = useRef<Set<EscapeHandler>>(new Set());
  const portalsRef = useRef<Set<HTMLElement>>(new Set());

  const registerEscapeHandler = useCallback((handler: EscapeHandler) => {
    escapeHandlersRef.current.add(handler);
    return () => {
      escapeHandlersRef.current.delete(handler);
    };
  }, []);

  const registerPortal = useCallback((portal: HTMLElement) => {
    portalsRef.current.add(portal);
    synchronizeBackgroundInertness();
    return () => {
      portalsRef.current.delete(portal);
      synchronizeBackgroundInertness();
    };
  }, []);

  const dialogContextValue = useMemo<DialogContextValue>(() => ({
    zIndex: effectiveZIndex,
    registerEscapeHandler,
    registerPortal,
  }), [effectiveZIndex, registerEscapeHandler, registerPortal]);

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
    openDialogs.set(root, {
      order: dialogOrder,
      zIndex: effectiveZIndex,
      escapeHandlers: escapeHandlersRef.current,
      portals: portalsRef.current,
    });
    synchronizeBackgroundInertness();

    const focusInitialElement = () => {
      if (getTopmostDialog() !== root) return;
      (initialFocusRef?.current ?? getFocusableElements(panel)[0] ?? panel).focus();
    };
    queueMicrotask(focusInitialElement);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (getTopmostDialog() !== root) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const entry = openDialogs.get(root);
        const handlers = entry ? Array.from(entry.escapeHandlers).reverse() : [];
        for (const handler of handlers) {
          if (handler() !== false) return;
        }

        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const entry = openDialogs.get(root);
      const focusableElements = entry
        ? getDialogFocusableElements(entry, panel)
        : getFocusableElements(panel);
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
      restoreFocusAfterDialogClose(previousFocusRef.current);
    };
  }, [dialogOrder, effectiveZIndex, initialFocusRef]);

  return createPortal(
    <ParentDialogZIndexContext.Provider value={effectiveZIndex}>
      <DialogContext.Provider value={dialogContextValue}>
        <div
          ref={rootRef}
          data-macro-dialog-root
          className={backdropClassName}
          style={{ zIndex: effectiveZIndex }}
          onClick={(event) => {
            if (closeOnBackdropClick && event.target === event.currentTarget) onClose();
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={ariaDescribedBy}
            tabIndex={-1}
            className={panelClassName}
          >
            <h2 id={titleId} className="sr-only">{title}</h2>
            {children}
          </div>
        </div>
      </DialogContext.Provider>
    </ParentDialogZIndexContext.Provider>,
    document.body
  );
};

export const hasOpenDialog = (): boolean =>
  typeof document !== 'undefined' && (
    document.querySelector('[data-macro-dialog-root]') !== null ||
    document.querySelector('[role="dialog"][aria-modal="true"]') !== null
  );
