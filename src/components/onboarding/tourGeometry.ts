import { devLogger } from '../../utils/devLogger';

export type TourTargetKind = 'primary' | 'fallback';

export interface TourTargetRequest {
  targetId: string;
  fallbackTargetId?: string;
}

export interface TourViewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
  scale: number;
}

export interface TourSpotlightRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface TourTargetResolution {
  element: HTMLElement;
  kind: TourTargetKind;
  targetId: string;
  duplicateCount: number;
  usedFallback: boolean;
}

export interface TourTargetMeasurement extends TourTargetResolution {
  rect: TourSpotlightRect;
  viewport: TourViewport;
  stable: boolean;
}

interface ResolveTargetOptions {
  requireViewportIntersection?: boolean;
}

interface MeasureStableTargetOptions {
  padding?: number;
  viewportPadding?: number;
  timeoutMs?: number;
  stableFrames?: number;
  tolerancePx?: number;
}

interface GeometryObserverOptions {
  target: HTMLElement | null;
  onChange: () => void;
}

const DEFAULT_TARGET_PADDING = 6;
const DEFAULT_VIEWPORT_PADDING = 1;
const DEFAULT_STABLE_FRAMES = 3;
const DEFAULT_STABLE_TIMEOUT_MS = 900;
const DEFAULT_STABLE_TOLERANCE_PX = 0.75;

const roundToDevicePixel = (value: number): number => {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.round(value * dpr) / dpr;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const escapeTourId = (targetId: string): string => {
  const css = typeof window !== 'undefined' ? window.CSS : undefined;
  if (css?.escape) {
    return css.escape(targetId);
  }

  return targetId.replace(/["\\]/g, '\\$&');
};

export const getTourViewport = (): TourViewport => {
  const visualViewport = typeof window !== 'undefined' ? window.visualViewport : null;

  return {
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
    offsetLeft: visualViewport?.offsetLeft ?? 0,
    offsetTop: visualViewport?.offsetTop ?? 0,
    scale: visualViewport?.scale ?? 1,
  };
};

const getIntersectionArea = (rect: DOMRect, viewport = getTourViewport()): number => {
  const left = Math.max(rect.left, viewport.offsetLeft);
  const top = Math.max(rect.top, viewport.offsetTop);
  const right = Math.min(rect.right, viewport.offsetLeft + viewport.width);
  const bottom = Math.min(rect.bottom, viewport.offsetTop + viewport.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
};

export const isTourElementUsable = (
  element: HTMLElement,
  options: ResolveTargetOptions = {}
): boolean => {
  if (!element.isConnected) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const opacity = Number.parseFloat(style.opacity || '1');
  const isVisible =
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    opacity > 0;

  if (!isVisible) {
    return false;
  }

  if (options.requireViewportIntersection === false) {
    return true;
  }

  return getIntersectionArea(rect) > 0;
};

const collectTourCandidates = (
  targetId: string | undefined,
  kind: TourTargetKind,
  options: ResolveTargetOptions
): TourTargetResolution[] => {
  if (!targetId || typeof document === 'undefined') {
    return [];
  }

  const selector = `[data-tour-id="${escapeTourId(targetId)}"]`;
  const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
  const usable = elements.filter((element) => isTourElementUsable(element, options));

  return usable.map((element) => ({
    element,
    kind,
    targetId,
    duplicateCount: usable.length,
    usedFallback: kind === 'fallback',
  }));
};

const chooseBestResolution = (
  resolutions: TourTargetResolution[]
): TourTargetResolution | null => {
  if (resolutions.length === 0) {
    return null;
  }

  if (resolutions.length > 1) {
    devLogger.debug('[onboarding] duplicate visible tour targets', {
      targetId: resolutions[0]?.targetId,
      count: resolutions.length,
    });
  }

  return [...resolutions].sort((left, right) => {
    const leftArea = getIntersectionArea(left.element.getBoundingClientRect());
    const rightArea = getIntersectionArea(right.element.getBoundingClientRect());
    if (rightArea !== leftArea) {
      return rightArea - leftArea;
    }
    return 0;
  })[0] ?? null;
};

export const resolveTourTarget = (
  request: TourTargetRequest,
  options: ResolveTargetOptions = {}
): TourTargetResolution | null => {
  const primary = chooseBestResolution(
    collectTourCandidates(request.targetId, 'primary', options)
  );

  if (primary) {
    return primary;
  }

  const fallback = chooseBestResolution(
    collectTourCandidates(request.fallbackTargetId, 'fallback', options)
  );

  if (fallback) {
    devLogger.debug('[onboarding] using fallback tour target', {
      targetId: request.targetId,
      fallbackTargetId: request.fallbackTargetId,
    });
  }

  return fallback;
};

export const toOverlayRect = (
  rect: DOMRect,
  {
    padding = DEFAULT_TARGET_PADDING,
    viewportPadding = DEFAULT_VIEWPORT_PADDING,
    viewport = getTourViewport(),
  }: {
    padding?: number;
    viewportPadding?: number;
    viewport?: TourViewport;
  } = {}
): TourSpotlightRect => {
  const minLeft = viewportPadding;
  const minTop = viewportPadding;
  const maxRight = Math.max(minLeft, viewport.width - viewportPadding);
  const maxBottom = Math.max(minTop, viewport.height - viewportPadding);

  const left = roundToDevicePixel(
    clamp(rect.left - viewport.offsetLeft - padding, minLeft, maxRight)
  );
  const top = roundToDevicePixel(
    clamp(rect.top - viewport.offsetTop - padding, minTop, maxBottom)
  );
  const right = roundToDevicePixel(
    clamp(rect.right - viewport.offsetLeft + padding, minLeft, maxRight)
  );
  const bottom = roundToDevicePixel(
    clamp(rect.bottom - viewport.offsetTop + padding, minTop, maxBottom)
  );

  return {
    top,
    right,
    bottom,
    left,
    width: Math.max(0, roundToDevicePixel(right - left)),
    height: Math.max(0, roundToDevicePixel(bottom - top)),
  };
};

const rectsAreClose = (
  left: TourSpotlightRect | null,
  right: TourSpotlightRect,
  tolerancePx: number
): boolean => {
  if (!left) {
    return false;
  }

  return (
    Math.abs(left.left - right.left) <= tolerancePx &&
    Math.abs(left.top - right.top) <= tolerancePx &&
    Math.abs(left.width - right.width) <= tolerancePx &&
    Math.abs(left.height - right.height) <= tolerancePx
  );
};

const waitForNextFrame = (): Promise<void> =>
  new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

export const measureTourTarget = (
  resolution: TourTargetResolution,
  options: Pick<MeasureStableTargetOptions, 'padding' | 'viewportPadding'> = {}
): TourTargetMeasurement => {
  const viewport = getTourViewport();
  return {
    ...resolution,
    rect: toOverlayRect(resolution.element.getBoundingClientRect(), {
      padding: options.padding,
      viewportPadding: options.viewportPadding,
      viewport,
    }),
    viewport,
    stable: true,
  };
};

export const measureStableTourTarget = async (
  request: TourTargetRequest,
  options: MeasureStableTargetOptions = {}
): Promise<TourTargetMeasurement | null> => {
  const {
    padding = DEFAULT_TARGET_PADDING,
    viewportPadding = DEFAULT_VIEWPORT_PADDING,
    stableFrames = DEFAULT_STABLE_FRAMES,
    timeoutMs = DEFAULT_STABLE_TIMEOUT_MS,
    tolerancePx = DEFAULT_STABLE_TOLERANCE_PX,
  } = options;
  const startedAt = performance.now();
  let lastRect: TourSpotlightRect | null = null;
  let lastElement: HTMLElement | null = null;
  let stableCount = 0;
  let lastMeasurement: TourTargetMeasurement | null = null;
  let hasScrolledTarget = false;

  while (performance.now() - startedAt <= timeoutMs) {
    const resolution = resolveTourTarget(request, {
      requireViewportIntersection: hasScrolledTarget,
    });

    if (!resolution) {
      await waitForNextFrame();
      continue;
    }

    if (!hasScrolledTarget) {
      resolution.element.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'auto',
      });
      hasScrolledTarget = true;
      await waitForNextFrame();
      continue;
    }

    const measurement = measureTourTarget(resolution, {
      padding,
      viewportPadding,
    });
    const sameElement = lastElement === resolution.element;
    const isClose = sameElement && rectsAreClose(lastRect, measurement.rect, tolerancePx);

    stableCount = isClose ? stableCount + 1 : 1;
    lastElement = resolution.element;
    lastRect = measurement.rect;
    lastMeasurement = measurement;

    if (stableCount >= stableFrames) {
      return {
        ...measurement,
        stable: true,
      };
    }

    await waitForNextFrame();
  }

  if (lastMeasurement) {
    devLogger.debug('[onboarding] tour target rect did not fully stabilize', {
      targetId: request.targetId,
      fallbackTargetId: request.fallbackTargetId,
      rect: lastMeasurement.rect,
    });
    return {
      ...lastMeasurement,
      stable: false,
    };
  }

  return null;
};

export const getScrollableAncestors = (
  element: HTMLElement | null
): Array<HTMLElement | Window> => {
  if (!element) {
    return [window];
  }

  const ancestors: Array<HTMLElement | Window> = [window];
  let current = element.parentElement;

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const overflow = `${style.overflow}${style.overflowX}${style.overflowY}`;
    if (/(auto|scroll|overlay)/.test(overflow)) {
      ancestors.push(current);
    }
    current = current.parentElement;
  }

  return ancestors;
};

export const observeTourGeometry = ({
  target,
  onChange,
}: GeometryObserverOptions): (() => void) => {
  let frameId = 0;
  const schedule = () => {
    window.cancelAnimationFrame(frameId);
    frameId = window.requestAnimationFrame(onChange);
  };

  const cleanups: Array<() => void> = [
    () => window.cancelAnimationFrame(frameId),
  ];

  const addEvent = (
    targetLike: EventTarget | null | undefined,
    eventName: string,
    options?: AddEventListenerOptions | boolean
  ) => {
    if (!targetLike) {
      return;
    }
    targetLike.addEventListener(eventName, schedule, options);
    cleanups.push(() => targetLike.removeEventListener(eventName, schedule, options));
  };

  const resizeObserver = new ResizeObserver(schedule);
  if (target) {
    resizeObserver.observe(target);
  }
  cleanups.push(() => resizeObserver.disconnect());

  const IntersectionObserverCtor = window.IntersectionObserver;
  if (IntersectionObserverCtor && target) {
    const intersectionObserver = new IntersectionObserverCtor(schedule);
    intersectionObserver.observe(target);
    cleanups.push(() => intersectionObserver.disconnect());
  }

  const mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(document.body, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['class', 'style', 'data-tour-id', 'hidden', 'aria-hidden'],
  });
  cleanups.push(() => mutationObserver.disconnect());

  getScrollableAncestors(target).forEach((ancestor) => {
    addEvent(ancestor, 'scroll', { capture: true, passive: true });
  });
  addEvent(window, 'resize');
  addEvent(document, 'transitionend', { capture: true });
  addEvent(document, 'animationend', { capture: true });
  addEvent(window.visualViewport, 'resize');
  addEvent(window.visualViewport, 'scroll');

  return () => {
    cleanups.forEach((cleanup) => cleanup());
  };
};
