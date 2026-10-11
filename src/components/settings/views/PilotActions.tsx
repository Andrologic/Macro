import React, { useContext, useEffect, useRef } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { DialogContext } from '../../ui/Dialog';

/** Small disclosure for secondary actions; native keyboard and focus semantics. */
export function PilotActions({ label, children }: { label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const dialog = useContext(DialogContext);
  useEffect(() => dialog?.registerEscapeHandler(() => {
    if (!ref.current?.open) return false;
    ref.current.open = false;
    ref.current.querySelector('summary')?.focus();
    return true;
  }), [dialog]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <details ref={ref} className="relative shrink-0" onKeyDown={event => {
    if (event.key === 'Tab') {
      requestAnimationFrame(() => {
        if (ref.current && !ref.current.contains(document.activeElement)) ref.current.open = false;
      });
    }
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.stopPropagation(); event.preventDefault(); event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  }}>
    <summary aria-label={label} title={label} className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
      <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
    </summary>
    <div className="absolute right-0 top-full z-20 mt-1 w-60 max-w-[70vw] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg [&>button]:w-full [&>button]:rounded-md [&>button]:px-3 [&>button]:py-2 [&>button]:text-left [&>button]:text-xs [&>button:hover]:bg-accent [&>button:focus-visible]:outline-primary [&>button:disabled]:opacity-50" onClick={event => {
      const button = (event.target as HTMLElement).closest('button');
      if (button && !button.disabled && ref.current) {
        ref.current.open = false; ref.current.querySelector('summary')?.focus();
      }
    }}>
      {children}
    </div>
  </details>;
}
