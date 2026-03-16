import React, { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';
import { Button } from './Button';
import { Input } from './Input';

interface ConfirmPromptModalProps {
  isOpen: boolean;
  title: string;
  description?: string;
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
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => {
          if (!isSubmitting) {
            onCancel();
          }
        }}
      />

      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card shadow-2xl p-4">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
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

        <div className={cn('mt-4 flex items-center justify-end gap-2')}>
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
