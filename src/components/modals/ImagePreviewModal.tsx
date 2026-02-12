import React, { useEffect, useRef } from 'react';
import { Icon } from '../ui/Icon';
import type { MessageImageAttachment } from '../../stores/useChatStore';

interface ImagePreviewModalProps {
  isOpen: boolean;
  image: MessageImageAttachment | null;
  onClose: () => void;
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ isOpen, image, onClose }) => {
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
      className="fixed inset-0 z-[90] flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={handleBackdropClick}
    >
      <div
        className="w-[92vw] max-w-5xl max-h-[90vh] bg-card border border-border shadow-2xl rounded-xl overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/20">
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
            title="Close"
          >
            <Icon name="x" size={16} className="text-muted-foreground" />
          </button>
        </div>

        <div className="p-3 md:p-4 flex items-center justify-center bg-background/40">
          <img
            src={image.dataUrl}
            alt="Preview"
            className="max-w-full max-h-[80vh] object-contain rounded-md border border-border"
          />
        </div>
      </div>
    </div>
  );
};
