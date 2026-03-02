import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';

interface PlanFormModalProps {
  mode: 'create' | 'rename';
  initialTitle?: string;
  onConfirm: (title: string, description?: string) => void;
  onClose: () => void;
  isLoading?: boolean;
  error?: string | null;
}

export const PlanFormModal: React.FC<PlanFormModalProps> = ({
  mode,
  initialTitle = '',
  onConfirm,
  onClose,
  isLoading = false,
  error = null,
}) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setLocalError(t('architect.planForm.nameRequired', 'Plan name is required.'));
      return;
    }
    setLocalError(null);
    onConfirm(title.trim(), description.trim() || undefined);
  };

  const displayError = localError || error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[420px] bg-card border border-border rounded-2xl shadow-2xl flex flex-col animate-in zoom-in-95 duration-200">
        {/* Header */}
        <header className="h-12 px-4 border-b border-border flex items-center gap-3 shrink-0">
          <div className="p-1.5 bg-primary/10 rounded-lg shrink-0">
            <Icon name={mode === 'create' ? 'plus' : 'edit'} size={14} className="text-primary" />
          </div>
          <h2 className="text-sm font-semibold text-foreground flex-1">
            {mode === 'create'
              ? t('architect.planForm.createTitle', 'New Plan')
              : t('architect.planForm.renameTitle', 'Rename Plan')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-accent flex items-center justify-center transition-colors"
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        {/* Body */}
        <form onSubmit={handleSubmit} id="plan-form">
          <div className="p-4 space-y-4">
            {displayError && (
              <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <Icon name="alert-circle" size={14} className="shrink-0" />
                <span>{displayError}</span>
              </div>
            )}

            <div>
              <label className="block text-sm text-muted-foreground mb-2">
                {t('architect.planForm.nameLabel', 'Plan name')} <span className="text-red-400">*</span>
              </label>
              <input
                ref={inputRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('architect.planForm.namePlaceholder', 'e.g. Authentication Overhaul')}
                className={cn(
                  'w-full bg-muted border rounded-lg px-3 py-2 text-sm text-foreground',
                  'placeholder:text-muted-foreground focus:outline-none transition-colors',
                  localError && !title.trim()
                    ? 'border-red-500/50 focus:border-red-500'
                    : 'border-border focus:border-primary'
                )}
              />
            </div>

            {mode === 'create' && (
              <div>
                <label className="block text-sm text-muted-foreground mb-2">
                  {t('architect.planForm.descriptionLabel', 'Description')}{' '}
                  <span className="text-xs opacity-60">({t('common.optional', 'optional')})</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('architect.planForm.descriptionPlaceholder', 'What is this plan about?')}
                  rows={3}
                  className={cn(
                    'w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground',
                    'placeholder:text-muted-foreground focus:outline-none focus:border-primary transition-colors resize-none'
                  )}
                />
              </div>
            )}
          </div>
        </form>

        {/* Footer */}
        <footer className="h-14 px-4 border-t border-border flex items-center justify-end gap-3 bg-card/50 shrink-0 rounded-b-2xl">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-4 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            form="plan-form"
            disabled={isLoading}
            className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {isLoading && <Icon name="loader" size={13} className="animate-spin" />}
            {mode === 'create'
              ? t('architect.planForm.createAction', 'Create Plan')
              : t('common.rename', 'Rename')}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default PlanFormModal;
