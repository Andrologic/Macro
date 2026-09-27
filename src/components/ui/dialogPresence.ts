/** Lightweight modal guard for global shortcuts, independent of dialog rendering. */
export const hasOpenDialog = (): boolean =>
  typeof document !== 'undefined' && (
    document.querySelector('[data-macro-dialog-root]') !== null ||
    document.querySelector('[role="dialog"][aria-modal="true"]') !== null
  );
