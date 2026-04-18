import React from 'react';
import { Icon } from '../ui/Icon';

interface ArchitectPlanNamingRecoveryModalProps {
  title: string;
  description: string;
  retryLabel: string;
  manualLabel: string;
  retryingLabel: string;
  error?: string | null;
  isLoading?: boolean;
  onRetry: () => void;
  onManual: () => void;
}

export const ArchitectPlanNamingRecoveryModal: React.FC<
  ArchitectPlanNamingRecoveryModalProps
> = ({
  title,
  description,
  retryLabel,
  manualLabel,
  retryingLabel,
  error = null,
  isLoading = false,
  onRetry,
  onManual,
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
    <div className="w-[440px] bg-card border border-border rounded-2xl shadow-2xl flex flex-col animate-in zoom-in-95 duration-200">
      <header className="h-12 px-4 border-b border-border flex items-center gap-3 shrink-0">
        <div className="p-1.5 bg-primary/10 rounded-lg shrink-0">
          <Icon name="sparkles" size={14} className="text-primary" />
        </div>
        <h2 className="text-sm font-semibold text-foreground flex-1">{title}</h2>
      </header>

      <div className="p-4 space-y-4">
        <p className="text-sm text-muted-foreground">{description}</p>

        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            <Icon name="alert-circle" size={14} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <footer className="h-14 px-4 border-t border-border flex items-center justify-end gap-3 bg-card/50 shrink-0 rounded-b-2xl">
        <button
          type="button"
          onClick={onRetry}
          disabled={isLoading}
          className="h-8 px-4 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          {isLoading && <Icon name="loader" size={13} className="animate-spin" />}
          {isLoading ? retryingLabel : retryLabel}
        </button>
        <button
          type="button"
          onClick={onManual}
          disabled={isLoading}
          className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {manualLabel}
        </button>
      </footer>
    </div>
  </div>
);

export default ArchitectPlanNamingRecoveryModal;
