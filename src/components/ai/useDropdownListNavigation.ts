import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface DropdownListNavigationOptions {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  itemCount: number;
  selectedIndex: number;
  onSelect: (index: number) => void;
}

export const useDropdownListNavigation = ({
  isOpen,
  setIsOpen,
  itemCount,
  selectedIndex,
  onSelect,
}: DropdownListNavigationOptions) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(Math.max(selectedIndex, 0));

  const open = useCallback((preferredIndex?: number) => {
    if (itemCount === 0) return;
    const nextIndex = preferredIndex ?? (selectedIndex >= 0 ? selectedIndex : 0);
    setActiveIndex(Math.max(0, Math.min(nextIndex, itemCount - 1)));
    setIsOpen(true);
  }, [itemCount, selectedIndex, setIsOpen]);

  const close = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, [setIsOpen]);

  const select = useCallback((index: number) => {
    if (index < 0 || index >= itemCount) return;
    onSelect(index);
    close(true);
  }, [close, itemCount, onSelect]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const frameId = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [activeIndex, isOpen]);

  const handleTriggerKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      open(selectedIndex >= 0 ? selectedIndex : itemCount - 1);
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      close(true);
    }
  }, [close, isOpen, itemCount, open, selectedIndex]);

  const handleListKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, itemCount - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(itemCount - 1, 0));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(activeIndex);
    }
  }, [activeIndex, close, itemCount, select]);

  return {
    activeIndex,
    close,
    handleListKeyDown,
    handleTriggerKeyDown,
    open,
    optionRefs,
    select,
    setActiveIndex,
    triggerRef,
  };
};
