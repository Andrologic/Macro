import { Toaster as SonnerToaster } from 'sonner';

/**
 * Toaster component to be placed at the app root.
 * Uses CSS variables from the theme for consistent styling.
 */
export function Toaster() {
  return (
    <SonnerToaster
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
          toast: 'rounded-lg shadow-lg',
          title: 'text-sm font-medium',
          description: 'text-xs text-muted-foreground',
          closeButton:
            'bg-transparent border-border hover:bg-accent text-muted-foreground',
          success: 'border-emerald-500/30 bg-emerald-500/10',
          error: 'border-red-500/30 bg-red-500/10',
          warning: 'border-amber-500/30 bg-amber-500/10',
          info: 'border-blue-500/30 bg-blue-500/10',
        },
      }}
    />
  );
}
