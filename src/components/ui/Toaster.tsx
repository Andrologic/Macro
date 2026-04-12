import { Toaster as SonnerToaster } from 'sonner';

/**
 * Toaster component to be placed at the app root.
 * Uses CSS variables from the theme for consistent styling.
 */
export function Toaster() {
  return (
    <SonnerToaster
      className="macro-toaster"
      position="bottom-right"
      expand={false}
      richColors
      closeButton
      duration={4000}
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
