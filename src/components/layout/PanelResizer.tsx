import { useRef, useEffect, useState, useCallback } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '../../utils/cn';

interface PanelResizerProps {
  onResize: (delta: number) => void;
  className?: string;
  disabled?: boolean;
}

export function PanelResizer({ onResize, className, disabled = false }: PanelResizerProps) {
  const resizerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const startPos = useRef(0);
  const onResizeRef = useRef(onResize);

  // Keep onResize ref up to date
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  const handleMouseDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (disabled) return;
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    startPos.current = 'clientX' in e ? e.clientX : e.touches[0].clientX;

    // Disable text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, [disabled]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      if (!isDraggingRef.current) return;

      const clientX = 'clientX' in e ? e.clientX : e.touches[0].clientX;
      const delta = clientX - startPos.current;

      onResizeRef.current(delta);
      startPos.current = clientX;
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('touchmove', handleMouseMove, { passive: false });
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchend', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('touchmove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchend', handleMouseUp);
    };
  }, []);

  return (
    <div
      ref={resizerRef}
      onMouseDown={handleMouseDown}
      onTouchStart={handleMouseDown}
      className={cn(
        'relative flex items-center justify-center transition-colors',
        'hover:bg-accent/50 active:bg-accent/60',
        'cursor-col-resize select-none',
        'z-10 shrink-0',
        isDragging && 'bg-accent/60',
        disabled && 'cursor-default hover:bg-transparent',
        className
      )}
      style={{ width: '6px' }}
    >
      <GripVertical
        className={cn(
          'w-4 h-4 text-muted-foreground transition-opacity',
          'hover:text-foreground',
          disabled && 'opacity-30',
          isDragging && 'text-foreground'
        )}
      />
    </div>
  );
}
