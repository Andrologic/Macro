import React, { useEffect, useId, useState } from 'react';
import { cn } from '../../utils/cn';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Input } from './Input';

interface ConfirmPromptModalProps {
  isOpen: boolean;
  title: string;
  description?: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  secondaryLabel?: string;
  confirmVariant?: 'primary' | 'error';
  initialValue?: string;
  inputPlaceholder?: string;
  requireInput?: boolean;
  isSubmitting?: boolean;
  showConfirmButton?: boolean;
  onCancel: () => void;
  onSecondary?: () => void;
  onConfirm: (value?: string) => void;
}

export const ConfirmPromptModal: React.FC<ConfirmPromptModalProps> = ({
  isOpen,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  secondaryLabel,
  confirmVariant = 'primary',
  initialValue = '',
  inputPlaceholder,
  requireInput = false,
  isSubmitting = false,
  showConfirmButton = true,
  onCancel,
  onSecondary,
  onConfirm,
}) => {
  const [value, setValue] = useState(initialValue);
  const descriptionId = useId();

  useEffect(() => {
    if (isOpen) {
      setValue(initialValue);
    }
  }, [isOpen, initialValue]);

  if (!isOpen) return null;

  const showInput = inputPlaceholder !== undefined || requireInput;
  const confirmDisabled = isSubmitting || (requireInput && !value.trim());

  return (
    <Dialog
      title={title}
      onClose={isSubmitting ? () => undefined : onCancel}
      closeOnBackdropClick={!isSubmitting}
      ariaDescribedBy={description ? descriptionId : undefined}
      backdropClassName="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      panelClassName="flex max-h-[calc(100vh-2rem)] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
    >
      <div
        className="contents"
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description && (
            <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">{description}</p>
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
                }}
              />
            </div>
          )}
        </div>

        <div className={cn('flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3')}>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
            {cancelLabel}
          </Button>
          {secondaryLabel && onSecondary && (
            <Button type="button" variant="secondary" size="sm" onClick={onSecondary} disabled={isSubmitting}>
              {secondaryLabel}
            </Button>
          )}
          {showConfirmButton && (
            <Button
              variant={confirmVariant === 'error' ? 'error' : 'primary'}
              size="sm"
              type="button"
              onClick={() => onConfirm(showInput ? value.trim() : undefined)}
              disabled={confirmDisabled}
            >
              {isSubmitting ? '...' : confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
};

export default ConfirmPromptModal;
