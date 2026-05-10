import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

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
const VIEWPORT_ANCHOR_SELECTOR = '[data-scroll-magnet-anchor]';

interface ViewportAnchor {
    anchorId: string;
    offsetTop: number;
}

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
    const viewportAnchorRef = useRef<ViewportAnchor | null>(null);
    const programmaticScrollRef = useRef(false);
    const scrollCaptureRafRef = useRef<number | null>(null);
    const pinnedScrollRafRef = useRef<number | null>(null);
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

    const isPinnedState = useCallback((nextState: SeparatorState) => (
        nextState === 'locked' ||
        nextState === 'detaching' ||
        nextState === 'reattaching'
    ), []);

    const schedulePinnedScrollToBottom = useCallback(() => {
        if (!isPinnedState(stateRef.current)) return;
        if (pinnedScrollRafRef.current !== null) {
            cancelAnimationFrame(pinnedScrollRafRef.current);
        }
        pinnedScrollRafRef.current = requestAnimationFrame(() => {
            pinnedScrollRafRef.current = null;
            if (!isPinnedState(stateRef.current)) return;
            const el = scrollContainerRef.current;
            if (!el) return;
            el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
        });
    }, [isPinnedState]);

    const findViewportAnchor = useCallback((): ViewportAnchor | null => {
        const el = scrollContainerRef.current;
        if (!el) return null;

        const containerRect = el.getBoundingClientRect();
        const anchors = Array.from(el.querySelectorAll<HTMLElement>(VIEWPORT_ANCHOR_SELECTOR));

        for (const anchor of anchors) {
            const anchorId = anchor.dataset.scrollMagnetAnchor;
            if (!anchorId) continue;

            const anchorRect = anchor.getBoundingClientRect();
            const intersectsViewport =
                anchorRect.bottom > containerRect.top &&
                anchorRect.top < containerRect.bottom;
            if (!intersectsViewport) continue;

            return {
                anchorId,
                offsetTop: anchorRect.top - containerRect.top,
            };
        }

        return null;
    }, []);

    const captureViewportAnchor = useCallback(() => {
        viewportAnchorRef.current = findViewportAnchor();
    }, [findViewportAnchor]);

    const restoreViewportAnchor = useCallback(() => {
        const el = scrollContainerRef.current;
        const anchor = viewportAnchorRef.current;
        if (!el) return;
        if (!anchor) {
            captureViewportAnchor();
            return;
        }

        const target = Array.from(
            el.querySelectorAll<HTMLElement>(VIEWPORT_ANCHOR_SELECTOR),
        ).find((candidate) => candidate.dataset.scrollMagnetAnchor === anchor.anchorId);
        if (!target) {
            captureViewportAnchor();
            return;
        }

        const containerRect = el.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const delta = targetRect.top - containerRect.top - anchor.offsetTop;

        if (Math.abs(delta) > 0.5) {
            programmaticScrollRef.current = true;
            el.scrollTop += delta;
            requestAnimationFrame(() => {
                programmaticScrollRef.current = false;
                captureViewportAnchor();
            });
            return;
        }

        captureViewportAnchor();
    }, [captureViewportAnchor]);

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
                    viewportAnchorRef.current = null;
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
        if (isPinnedState(state)) {
            viewportAnchorRef.current = null;
            schedulePinnedScrollToBottom();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, state, isPinnedState, schedulePinnedScrollToBottom]);

    // ---------------------------------------------------------------------------
    // Keep pinned when existing content changes height.
    //
    // Message deps cover streamed text and new rows, but expanding an already
    // rendered block (for example a completed tool accordion) can increase the
    // transcript height without changing message data. Observe the scroll
    // content itself so locked magnetism follows those layout-only changes.
    // ---------------------------------------------------------------------------

    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;

        const resizeObserver = new ResizeObserver(() => {
            schedulePinnedScrollToBottom();
        });

        const observeScrollContent = () => {
            resizeObserver.disconnect();
            resizeObserver.observe(el);
            Array.from(el.children).forEach((child) => {
                if (child instanceof HTMLElement) {
                    resizeObserver.observe(child);
                }
            });
        };

        observeScrollContent();

        const mutationObserver = new MutationObserver(observeScrollContent);
        mutationObserver.observe(el, { childList: true });

        return () => {
            mutationObserver.disconnect();
            resizeObserver.disconnect();
        };
    }, [schedulePinnedScrollToBottom]);

    // ---------------------------------------------------------------------------
    // Preserve the user's viewport while detached.
    //
    // Streaming content and virtual row re-measurements can change scrollTop even
    // when we are no longer intentionally pinned to the bottom. Keep the same
    // visible message at the same viewport offset until the user scrolls again.
    // ---------------------------------------------------------------------------

    useLayoutEffect(() => {
        if (state !== 'detached') return;
        restoreViewportAnchor();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, state]);

    useEffect(() => {
        if (state === 'detached') {
            requestAnimationFrame(captureViewportAnchor);
        } else {
            viewportAnchorRef.current = null;
        }
    }, [captureViewportAnchor, state]);

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

    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;

        const handleScroll = () => {
            if (stateRef.current !== 'detached' || programmaticScrollRef.current) {
                return;
            }
            if (scrollCaptureRafRef.current !== null) {
                cancelAnimationFrame(scrollCaptureRafRef.current);
            }
            scrollCaptureRafRef.current = requestAnimationFrame(() => {
                scrollCaptureRafRef.current = null;
                captureViewportAnchor();
            });
        };

        el.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            el.removeEventListener('scroll', handleScroll);
            if (scrollCaptureRafRef.current !== null) {
                cancelAnimationFrame(scrollCaptureRafRef.current);
                scrollCaptureRafRef.current = null;
            }
        };
    }, [captureViewportAnchor]);

    // ---------------------------------------------------------------------------
    // Cleanup
    // ---------------------------------------------------------------------------

    useEffect(() => {
        return () => clearTimer();
    }, [clearTimer]);

    useEffect(() => {
        return () => {
            if (pinnedScrollRafRef.current !== null) {
                cancelAnimationFrame(pinnedScrollRafRef.current);
                pinnedScrollRafRef.current = null;
            }
        };
    }, []);

    return { scrollContainerRef, separatorState: state, scrollToBottom };
}
