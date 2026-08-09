import { useRef, useEffect, useState, useCallback } from 'react';
import { GripVertical, GripHorizontal } from 'lucide-react';
import { cn } from '../../utils/cn';

interface PanelResizerProps {
  onResize: (delta: number) => void;
  className?: string;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  ariaLabel?: string;
}

const RESIZER_ICON_SIZE_PX = 6;
const RESIZER_VERTICAL_GUTTER_PX = 6;
const RESIZER_HORIZONTAL_GUTTER_PX = 6;

export function PanelResizer({
  onResize,
  className,
  disabled = false,
  orientation = 'horizontal',
  ariaLabel = 'Resize panel',
}: PanelResizerProps) {
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
    startPos.current =
      orientation === 'vertical'
        ? 'clientY' in e
          ? e.clientY
          : e.touches[0].clientY
        : 'clientX' in e
          ? e.clientX
          : e.touches[0].clientX;

    // Disable text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = orientation === 'vertical' ? 'row-resize' : 'col-resize';
  }, [disabled, orientation]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = event.shiftKey ? 32 : 8;
    const delta = orientation === 'vertical'
      ? event.key === 'ArrowUp'
        ? -step
        : event.key === 'ArrowDown'
          ? step
          : null
      : event.key === 'ArrowLeft'
        ? -step
        : event.key === 'ArrowRight'
          ? step
          : null;
    if (delta === null) return;
    event.preventDefault();
    onResizeRef.current(delta);
  }, [disabled, orientation]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      if (!isDraggingRef.current) return;

      const currentPos =
        orientation === 'vertical'
          ? 'clientY' in e
            ? e.clientY
            : e.touches[0].clientY
          : 'clientX' in e
            ? e.clientX
            : e.touches[0].clientX;
      const delta = currentPos - startPos.current;

      onResizeRef.current(delta);
      startPos.current = currentPos;
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
  }, [orientation]);

  return (
    <div
      ref={resizerRef}
      role="separator"
      aria-label={ariaLabel}
      aria-orientation={orientation === 'vertical' ? 'horizontal' : 'vertical'}
      tabIndex={disabled ? -1 : 0}
      onMouseDown={handleMouseDown}
      onTouchStart={handleMouseDown}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative flex items-center justify-center transition-colors',
        'hover:bg-accent/50 active:bg-accent/60',
        'focus-visible:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50',
        orientation === 'vertical' ? 'cursor-row-resize select-none' : 'cursor-col-resize select-none',
        'z-10 shrink-0',
        isDragging && 'bg-accent/60',
        disabled && 'cursor-default hover:bg-transparent',
        className
      )}
      style={
        orientation === 'vertical'
          ? { height: `${RESIZER_VERTICAL_GUTTER_PX}px` }
          : { width: `${RESIZER_HORIZONTAL_GUTTER_PX}px` }
      }
    >
      {orientation === 'vertical' ? (
        <GripHorizontal
          size={RESIZER_ICON_SIZE_PX}
          className={cn(
            'text-muted-foreground transition-opacity hover:text-foreground',
            disabled && 'opacity-30',
            isDragging && 'text-foreground'
          )}
          style={{
            width: `${RESIZER_ICON_SIZE_PX}px`,
            height: `${RESIZER_ICON_SIZE_PX}px`,
          }}
        />
      ) : (
        <GripVertical
          size={RESIZER_ICON_SIZE_PX}
          className={cn(
            'text-muted-foreground transition-opacity hover:text-foreground',
            disabled && 'opacity-30',
            isDragging && 'text-foreground'
          )}
          style={{
            width: `${RESIZER_ICON_SIZE_PX}px`,
            height: `${RESIZER_ICON_SIZE_PX}px`,
          }}
        />
      )}
    </div>
  );
}
