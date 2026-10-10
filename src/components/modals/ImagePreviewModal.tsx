import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import type { MessageImageAttachment } from '../../stores/useChatStore';

interface ImagePreviewModalProps {
  isOpen: boolean;
  image: MessageImageAttachment | null;
  onClose: () => void;
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ isOpen, image, onClose }) => {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [backdropReady, setBackdropReady] = useState(false);

  useEffect(() => {
    setBackdropReady(false);
    if (!isOpen || !image) return;
    const timer = setTimeout(() => setBackdropReady(true), 160);
    return () => clearTimeout(timer);
  }, [isOpen, image]);

  if (!isOpen || !image) return null;

  return (
    <Dialog
      title={t('implement.previewTab', 'Preview')}
      onClose={onClose}
      initialFocusRef={closeRef}
      closeOnBackdropClick={backdropReady}
      backdropClassName="fixed inset-0 z-[90] flex items-center justify-center bg-background/80 p-4 animate-in fade-in duration-200"
      panelClassName="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl animate-in zoom-in-95 duration-200"
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
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="p-1.5 hover:bg-accent rounded-md transition-colors"
          title={t('common.close', 'Close')}
          aria-label={t('common.close', 'Close')}
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
    </Dialog>
  );
};
