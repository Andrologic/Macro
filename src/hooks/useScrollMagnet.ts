import { useEffect, useRef, useState, useCallback } from 'react';

export type SeparatorState =
    | 'idle'
    | 'locked'
    | 'releasing'
    | 'detaching'
    | 'detached'
    | 'reattaching';

const SCROLL_THRESHOLD = 50; // px from bottom to consider "at bottom"
const RELEASE_DURATION = 400; // ms for releasing / detaching animation
const REATTACH_DURATION = 300; // ms for reattaching animation

/**
 * useScrollMagnet – Manages auto-scroll magnetism during streaming.
 *
 * The separator color bar acts as a "gate": while locked, the user's wheel
 * events are absorbed (preventDefault). Scrolling up triggers the detaching
 * animation. Only once that animation finishes is the scroll actually freed.
 * This prevents the vibration caused by auto-scroll fighting user input.
 *
 * State machine:
 *   idle ─(streaming starts)──► locked ─(streaming ends)──► releasing ──► idle
 *                                  │                                       ▲
 *                                  ├─(user scrolls up)──► detaching ──► detached
 *                                  │                                       │
 *                                  └───────────────(scroll to bottom)──────┘
 *                                           via reattaching ──► locked
 */
export function useScrollMagnet(
    isStreaming: boolean,
    deps: unknown[],
): {
    scrollContainerRef: React.RefObject<HTMLDivElement | null>;
    separatorState: SeparatorState;
    scrollToBottom: () => void;
} {
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const [state, setState] = useState<SeparatorState>('idle');
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevStreamingRef = useRef(isStreaming);
    // Keep a mutable ref in sync with state so event handlers always read fresh
    const stateRef = useRef<SeparatorState>(state);
    useEffect(() => { stateRef.current = state; }, [state]);

    // Also keep a mutable ref for isStreaming to avoid re-registering listeners
    const isStreamingRef = useRef(isStreaming);
    useEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    const clearTimer = useCallback(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const isNearBottom = useCallback(() => {
        const el = scrollContainerRef.current;
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD;
    }, []);

    const scrollToBottom = useCallback(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, []);

    // ---------------------------------------------------------------------------
    // React to streaming start / stop
    // ---------------------------------------------------------------------------

    useEffect(() => {
        const wasStreaming = prevStreamingRef.current;
        prevStreamingRef.current = isStreaming;

        if (isStreaming && !wasStreaming) {
            // New streaming started → force lock regardless of current state
            clearTimer();
            setState('locked');
            // Immediately scroll to bottom
            requestAnimationFrame(() => scrollToBottom());
        } else if (!isStreaming && wasStreaming) {
            // Streaming ended
            setState((prev) => {
                if (prev === 'locked' || prev === 'reattaching') {
                    // Transition locked → releasing → idle
                    clearTimer();
                    timerRef.current = setTimeout(() => {
                        setState('idle');
                    }, RELEASE_DURATION);
                    return 'releasing';
                }
                // If already detached/detaching, just stay where we are
                if (prev === 'detaching') {
                    return prev;
                }
                if (prev === 'detached') {
                    return 'idle';
                }
                return 'idle';
            });
        }
    }, [isStreaming, clearTimer, scrollToBottom]);

    // ---------------------------------------------------------------------------
    // Auto-scroll while locked or detaching (react to message changes)
    // Both states keep the scroll pinned to the bottom.
    // ---------------------------------------------------------------------------

    useEffect(() => {
        if (state === 'locked' || state === 'detaching' || state === 'reattaching') {
            requestAnimationFrame(() => {
                const el = scrollContainerRef.current;
                if (el) {
                    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
                }
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, state]);

    // ---------------------------------------------------------------------------
    // Wheel event interception — the "gate" mechanism
    //
    // In locked / detaching / reattaching states we block the user's wheel
    // events entirely (preventDefault). This avoids the vibration because
    // the browser never actually scrolls — only our programmatic scrollTo
    // moves the viewport.
    //
    // When the user scrolls up (deltaY < 0) while locked, we start the
    // detaching animation. Only when the timer fires and we enter "detached"
    // does the wheel listener stop blocking.
    // ---------------------------------------------------------------------------

    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;

        const handleWheel = (e: WheelEvent) => {
            const s = stateRef.current;

            if (s === 'locked') {
                // Block all wheel events while locked
                e.preventDefault();

                if (e.deltaY < 0) {
                    // User is trying to scroll up → begin detaching
                    clearTimer();
                    timerRef.current = setTimeout(() => {
                        setState('detached');
                    }, RELEASE_DURATION);
                    setState('detaching');
                }
                return;
            }

            if (s === 'detaching' || s === 'reattaching') {
                // Keep blocking while the animation plays out
                e.preventDefault();
                return;
            }

            // --- User actively scrolls DOWN while detached & near bottom → reattach ---
            if ((s === 'detached' || s === 'idle') && e.deltaY > 0 && isNearBottom() && isStreamingRef.current) {
                e.preventDefault();
                clearTimer();
                timerRef.current = setTimeout(() => {
                    setState('locked');
                }, REATTACH_DURATION);
                setState('reattaching');
                return;
            }

            // In detached / idle / releasing → allow normal scrolling
        };

        // Must be non-passive to allow preventDefault
        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => {
            el.removeEventListener('wheel', handleWheel);
        };
    }, [clearTimer, isNearBottom]);

    // ---------------------------------------------------------------------------
    // Cleanup
    // ---------------------------------------------------------------------------

    useEffect(() => {
        return () => clearTimer();
    }, [clearTimer]);

    return { scrollContainerRef, separatorState: state, scrollToBottom };
}
