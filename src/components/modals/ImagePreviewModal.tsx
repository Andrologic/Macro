import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import type { MessageImageAttachment } from '../../stores/useChatStore';

interface ImagePreviewModalProps {
  isOpen: boolean;
  image: MessageImageAttachment | null;
  onClose: () => void;
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ isOpen, image, onClose }) => {
  const { t } = useTranslation();
  const openedAtRef = useRef<number>(0);

  useEffect(() => {
    if (!isOpen) return;
    openedAtRef.current = Date.now();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !image) return null;

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (Date.now() - openedAtRef.current < 160) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={handleBackdropClick}
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl animate-in zoom-in-95 duration-200"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between px-4 py-3 border-b border-border bg-muted/20">
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-1.5 rounded-md bg-primary/10">
              <Icon name="camera" size={14} className="text-primary" />
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {image.mimeType}
              {image.width && image.height ? ` • ${image.width}x${image.height}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 hover:bg-accent rounded-md transition-colors"
            title={t('common.close', 'Close')}
          >
            <Icon name="x" size={16} className="text-muted-foreground" />
          </button>
        </div>

        <div className="min-h-0 flex flex-1 items-center justify-center overflow-auto bg-background/40 p-3 md:p-4">
          <img
            src={image.dataUrl}
            alt={t('implement.previewTab', 'Preview')}
            className="max-h-full max-w-full rounded-md border border-border object-contain"
          />
        </div>
      </div>
    </div>
  );
};
