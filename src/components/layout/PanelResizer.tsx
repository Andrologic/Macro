import { useRef, useEffect, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '../../utils/cn';

interface PanelResizerProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
  className?: string;
  disabled?: boolean;
}

export function PanelResizer({ direction, onResize, className, disabled = false }: PanelResizerProps) {
  const resizerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const startPos = useRef(0);

  useEffect(() => {
    const resizer = resizerRef.current;
    if (!resizer) return;

    const handleMouseDown = (e: MouseEvent | TouchEvent) => {
      if (disabled) return;
      e.preventDefault();
      setIsDragging(true);
      startPos.current = 'clientX' in e ? e.clientX : e.touches[0].clientX;

      // Disable text selection during drag
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    };

    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      if (!isDragging) return;

      const clientX = 'clientX' in e ? e.clientX : e.touches[0].clientX;
      const delta = clientX - startPos.current;

      onResize(delta);
      startPos.current = clientX;
    };

    const handleMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    };

    resizer.addEventListener('mousedown', handleMouseDown);
    resizer.addEventListener('touchstart', handleMouseDown, { passive: false });

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('touchmove', handleMouseMove, { passive: false });

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchend', handleMouseUp);

    return () => {
      resizer.removeEventListener('mousedown', handleMouseDown);
      resizer.removeEventListener('touchstart', handleMouseDown);

      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('touchmove', handleMouseMove);

      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchend', handleMouseUp);
    };
  }, [isDragging, onResize, disabled]);

  return (
    <div
      ref={resizerRef}
      className={cn(
        'relative flex items-center justify-center transition-colors',
        'hover:bg-accent/50 active:bg-accent/60',
        'cursor-col-resize select-none',
        'z-10',
        isDragging && 'bg-accent/60',
        disabled && 'cursor-default hover:bg-transparent',
        className
      )}
      style={{ width: '4px' }}
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
