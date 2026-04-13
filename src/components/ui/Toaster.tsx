import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Toaster as SonnerToaster } from 'sonner';
import {
  getToastBatchSnapshot,
  pauseToastBatchTimer,
  resumeToastBatchTimer,
  subscribeToToastBatch,
  TOAST_BATCH_DURATION_MS,
} from './toastBatchController';

/**
 * Toaster component to be placed at the app root.
 * Uses CSS variables from the theme for consistent styling.
 */
export function Toaster() {
  const toasterRef = useRef<HTMLElement | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [hasFocusWithin, setHasFocusWithin] = useState(false);
  const toastBatch = useSyncExternalStore(
    subscribeToToastBatch,
    getToastBatchSnapshot,
    getToastBatchSnapshot
  );
  const isExpanded = isHovered || hasFocusWithin;
  const visibleToasts = isExpanded
    ? Math.max(3, toastBatch.activeToastIds.length)
    : 3;

  useEffect(() => {
    const toasterNode = toasterRef.current;
    if (!toasterNode) {
      return;
    }

    const handleMouseEnter = () => {
      setIsHovered(true);
    };

    const handleMouseLeave = () => {
      setIsHovered(false);
    };

    const handleFocusIn = () => {
      setHasFocusWithin(true);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && toasterNode.contains(nextTarget)) {
        return;
      }

      setHasFocusWithin(false);
    };

    toasterNode.addEventListener('mouseenter', handleMouseEnter);
    toasterNode.addEventListener('mouseleave', handleMouseLeave);
    toasterNode.addEventListener('focusin', handleFocusIn);
    toasterNode.addEventListener('focusout', handleFocusOut);

    return () => {
      toasterNode.removeEventListener('mouseenter', handleMouseEnter);
      toasterNode.removeEventListener('mouseleave', handleMouseLeave);
      toasterNode.removeEventListener('focusin', handleFocusIn);
      toasterNode.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  useEffect(() => {
    if (toastBatch.activeToastIds.length === 0) {
      return;
    }

    if (isExpanded) {
      pauseToastBatchTimer();
      return;
    }

    resumeToastBatchTimer();
  }, [isExpanded, toastBatch.activeToastIds.length]);

  return (
    <SonnerToaster
      ref={toasterRef}
      className="macro-toaster"
      position="bottom-right"
      expand={isExpanded}
      richColors
      closeButton
      duration={TOAST_BATCH_DURATION_MS}
      visibleToasts={visibleToasts}
      toastOptions={{
        style: {
          background: 'hsl(var(--card))',
          border: '1px solid hsl(var(--border))',
          color: 'hsl(var(--foreground))',
        },
        classNames: {
          toast: 'macro-toast rounded-lg shadow-lg',
          title: 'macro-toast-title',
          description: 'macro-toast-description',
          content: 'macro-toast-content',
          icon: 'macro-toast-icon',
          closeButton: 'macro-toast-close',
          actionButton: 'macro-toast-action',
          cancelButton: 'macro-toast-cancel',
          default: 'macro-toast-default',
          loading: 'macro-toast-loading',
          success: 'macro-toast-success',
          error: 'macro-toast-error',
          warning: 'macro-toast-warning',
          info: 'macro-toast-info',
        },
      }}
    />
  );
}
