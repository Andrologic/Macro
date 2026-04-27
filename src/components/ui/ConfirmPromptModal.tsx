import React, { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';
import { Button } from './Button';
import { Input } from './Input';

interface ConfirmPromptModalProps {
  isOpen: boolean;
  title: string;
  description?: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'primary' | 'error';
  initialValue?: string;
  inputPlaceholder?: string;
  requireInput?: boolean;
  isSubmitting?: boolean;
  onCancel: () => void;
  onConfirm: (value?: string) => void;
}

export const ConfirmPromptModal: React.FC<ConfirmPromptModalProps> = ({
  isOpen,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  initialValue = '',
  inputPlaceholder,
  requireInput = false,
  isSubmitting = false,
  onCancel,
  onConfirm,
}) => {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (isOpen) {
      setValue(initialValue);
    }
  }, [isOpen, initialValue]);

  if (!isOpen) return null;

  const showInput = inputPlaceholder !== undefined || requireInput;
  const confirmDisabled = isSubmitting || (requireInput && !value.trim());

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => {
          if (!isSubmitting) {
            onCancel();
          }
        }}
      />

      <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description && (
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          )}

          {children && (
            <div className="mt-3">{children}</div>
          )}

          {showInput && (
            <div className="mt-3">
              <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={inputPlaceholder}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !confirmDisabled) {
                    onConfirm(value.trim());
                  }
                  if (event.key === 'Escape' && !isSubmitting) {
                    onCancel();
                  }
                }}
              />
            </div>
          )}
        </div>

        <div className={cn('flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3')}>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant === 'error' ? 'error' : 'primary'}
            size="sm"
            onClick={() => onConfirm(showInput ? value.trim() : undefined)}
            disabled={confirmDisabled}
          >
            {isSubmitting ? '...' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmPromptModal;
