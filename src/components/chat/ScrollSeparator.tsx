import React from 'react';
import { cn } from '../../utils/cn';
import type { SeparatorState } from '../../hooks/useScrollMagnet';

interface ScrollSeparatorProps {
    state: SeparatorState;
}

/**
 * Animated separator between chat messages and input area.
 * Communicates scroll-magnetism state via a primary-colored gradient line.
 */
export const ScrollSeparator: React.FC<ScrollSeparatorProps> = ({ state }) => {
    const isActive = state === 'locked' || state === 'releasing' || state === 'detaching' || state === 'reattaching';

    return (
        <div className="relative h-[2px] w-full bg-border/50 shrink-0">
            {/* Animated primary gradient overlay */}
            <div
                className={cn(
                    'absolute inset-0 scroll-separator-line',
                    state === 'locked' && 'separator-locked',
                    state === 'releasing' && 'separator-releasing',
                    state === 'detaching' && 'separator-detaching',
                    state === 'reattaching' && 'separator-reattaching',
                    !isActive && 'opacity-0',
                )}
            />
        </div>
    );
};
