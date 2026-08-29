import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { loadPreference, PREF_KEYS, savePreference } from '../../services/preferences';
import { useAppStore } from '../../stores/useAppStore';
import type { AppMode } from '../../types';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';
import { TourSpotlightOverlay } from './TourSpotlightOverlay';
import {
  getTourViewport,
  measureStableTourTarget,
  observeTourGeometry,
  type TourTargetMeasurement,
} from './tourGeometry';
import {
  ONBOARDING_VERSION,
  type OnboardingPreferenceState,
} from './onboardingPreference';

const PANEL_GAP = 14;
const VIEWPORT_PADDING = 14;

type TourSection = 'basics' | 'architect' | 'implement' | 'chat' | 'system';
type TourPlacement = 'top' | 'right' | 'bottom' | 'left' | 'center';

interface TourStep {
  id: string;
  section: TourSection;
  mode?: AppMode;
  targetId: string;
  fallbackTargetId?: string;
  openLeft?: boolean;
  openRight?: boolean;
  placement?: TourPlacement;
  icon: IconName;
  pointCount?: number;
}

interface PanelSize {
  width: number;
  height: number;
}

interface PanelPosition {
  top: number;
  left: number;
  placement: TourPlacement;
}

interface TourOriginState {
  mode: AppMode;
  isLeftOpen: boolean;
  isRightOpen: boolean;
}

const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    section: 'basics',
    targetId: 'app-shell',
    placement: 'center',
    icon: 'sparkles',
    pointCount: 3,
  },
  {
    id: 'modes',
    section: 'basics',
    targetId: 'mode-switcher',
    placement: 'bottom',
    icon: 'compass',
    pointCount: 3,
  },
  {
    id: 'panel-toggles',
    section: 'basics',
    targetId: 'toggle-right-panel',
    fallbackTargetId: 'mode-context-header',
    placement: 'bottom',
    icon: 'panel-right-open',
  },
  {
    id: 'settings-and-help',
    section: 'basics',
    targetId: 'settings-button',
    placement: 'bottom',
    icon: 'settings',
  },
  {
    id: 'architect-mode',
    section: 'architect',
    mode: 'Architect',
    targetId: 'mode-architect',
    fallbackTargetId: 'mode-switcher',
    openLeft: false,
    openRight: true,
    placement: 'bottom',
    icon: 'compass',
  },
  {
    id: 'architect-plan-selector',
    section: 'architect',
    mode: 'Architect',
    targetId: 'architect-plan-selector',
    fallbackTargetId: 'mode-context-header',
    openLeft: false,
    openRight: true,
    placement: 'bottom',
    icon: 'layers',
  },
  {
    id: 'architect-generate',
    section: 'architect',
    mode: 'Architect',
    targetId: 'architect-generate-strategy',
    fallbackTargetId: 'chat-control-row',
    openLeft: false,
    openRight: true,
    placement: 'top',
    icon: 'sparkles',
  },
  {
    id: 'architect-strategy',
    section: 'architect',
    mode: 'Architect',
    targetId: 'architect-strategy-panel',
    fallbackTargetId: 'right-panel',
    openLeft: false,
    openRight: true,
    placement: 'left',
    icon: 'network',
    pointCount: 3,
  },
  {
    id: 'architect-validate',
    section: 'architect',
    mode: 'Architect',
    targetId: 'architect-validate-plan',
    fallbackTargetId: 'architect-strategy-panel',
    openLeft: true,
    openRight: true,
    placement: 'top',
    icon: 'shield',
  },
  {
    id: 'implement-mode',
    section: 'implement',
    mode: 'Implement',
    targetId: 'mode-implement',
    fallbackTargetId: 'mode-switcher',
    openLeft: true,
    openRight: true,
    placement: 'bottom',
    icon: 'code',
  },
  {
    id: 'implement-tasks',
    section: 'implement',
    mode: 'Implement',
    targetId: 'implement-task-panel',
    fallbackTargetId: 'left-panel',
    openLeft: true,
    openRight: true,
    placement: 'right',
    icon: 'list-todo',
  },
  {
    id: 'implement-agent',
    section: 'implement',
    mode: 'Implement',
    targetId: 'implement-agent-toggle',
    fallbackTargetId: 'chat-control-row',
    openLeft: true,
    openRight: true,
    placement: 'top',
    icon: 'map',
  },
  {
    id: 'implement-terminal',
    section: 'implement',
    mode: 'Implement',
    targetId: 'implement-terminal-toggle',
    fallbackTargetId: 'mode-context-header',
    openLeft: true,
    openRight: true,
    placement: 'bottom',
    icon: 'terminal',
  },
  {
    id: 'implement-changes',
    section: 'implement',
    mode: 'Implement',
    targetId: 'implement-changes-panel',
    fallbackTargetId: 'right-panel',
    openLeft: true,
    openRight: true,
    placement: 'left',
    icon: 'git-compare',
  },
  {
    id: 'chat-mode',
    section: 'chat',
    mode: 'Chat',
    targetId: 'mode-chat',
    fallbackTargetId: 'mode-switcher',
    openLeft: true,
    openRight: true,
    placement: 'bottom',
    icon: 'message-circle',
  },
  {
    id: 'chat-conversations',
    section: 'chat',
    mode: 'Chat',
    targetId: 'chat-conversations-panel',
    fallbackTargetId: 'left-panel',
    openLeft: true,
    openRight: true,
    placement: 'right',
    icon: 'message-square',
  },
  {
    id: 'chat-toolbox',
    section: 'chat',
    mode: 'Chat',
    targetId: 'chat-toolbox-panel',
    fallbackTargetId: 'right-panel',
    openLeft: true,
    openRight: true,
    placement: 'left',
    icon: 'layout-grid',
  },
  {
    id: 'chat-models',
    section: 'chat',
    mode: 'Chat',
    targetId: 'chat-control-row',
    fallbackTargetId: 'chat-footer',
    openLeft: true,
    openRight: true,
    placement: 'top',
    icon: 'cpu',
  },
  {
    id: 'composer',
    section: 'chat',
    mode: 'Chat',
    targetId: 'chat-composer',
    fallbackTargetId: 'chat-footer',
    openLeft: true,
    openRight: true,
    placement: 'top',
    icon: 'arrow-up',
  },
  {
    id: 'footer',
    section: 'system',
    mode: 'Implement',
    targetId: 'footer-status-bar',
    fallbackTargetId: 'app-shell',
    openLeft: true,
    openRight: true,
    placement: 'top',
    icon: 'git-branch',
  },
  {
    id: 'done',
    section: 'system',
    targetId: 'onboarding-help',
    fallbackTargetId: 'settings-button',
    placement: 'bottom',
    icon: 'check-circle',
  },
];

const SECTION_LABEL_KEYS: Record<TourSection, string> = {
  basics: 'onboarding.sections.basics',
  architect: 'onboarding.sections.architect',
  implement: 'onboarding.sections.implement',
  chat: 'onboarding.sections.chat',
  system: 'onboarding.sections.system',
};

const getStepTranslationKey = (
  stepId: string,
  field: 'title' | 'body' | `points.${number}`
): string => `onboarding.steps.${stepId}.${field}`;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const resolvePanelPosition = (
  targetRect: TourTargetMeasurement['rect'] | null,
  panelSize: PanelSize,
  preferredPlacement: TourPlacement = 'bottom'
): PanelPosition => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxLeft = Math.max(VIEWPORT_PADDING, viewportWidth - panelSize.width - VIEWPORT_PADDING);
  const maxTop = Math.max(VIEWPORT_PADDING, viewportHeight - panelSize.height - VIEWPORT_PADDING);

  if (!targetRect || preferredPlacement === 'center') {
    return {
      placement: 'center',
      left: clamp((viewportWidth - panelSize.width) / 2, VIEWPORT_PADDING, maxLeft),
      top: clamp((viewportHeight - panelSize.height) / 2, VIEWPORT_PADDING, maxTop),
    };
  }

  const orderedPlacements: TourPlacement[] = [
    preferredPlacement,
    'bottom',
    'top',
    'right',
    'left',
  ];
  const placements = orderedPlacements.filter(
    (placement, index, list) => list.indexOf(placement) === index
  );

  const candidateForPlacement = (placement: TourPlacement): PanelPosition => {
    switch (placement) {
      case 'top':
        return {
          placement,
          left: targetRect.left + targetRect.width / 2 - panelSize.width / 2,
          top: targetRect.top - panelSize.height - PANEL_GAP,
        };
      case 'right':
        return {
          placement,
          left: targetRect.right + PANEL_GAP,
          top: targetRect.top + targetRect.height / 2 - panelSize.height / 2,
        };
      case 'left':
        return {
          placement,
          left: targetRect.left - panelSize.width - PANEL_GAP,
          top: targetRect.top + targetRect.height / 2 - panelSize.height / 2,
        };
      case 'bottom':
      default:
        return {
          placement: 'bottom',
          left: targetRect.left + targetRect.width / 2 - panelSize.width / 2,
          top: targetRect.bottom + PANEL_GAP,
        };
    }
  };

  const fits = (position: PanelPosition): boolean =>
    position.left >= VIEWPORT_PADDING &&
    position.top >= VIEWPORT_PADDING &&
    position.left + panelSize.width <= viewportWidth - VIEWPORT_PADDING &&
    position.top + panelSize.height <= viewportHeight - VIEWPORT_PADDING;

  const preferred = placements.map(candidateForPlacement).find(fits) ??
    candidateForPlacement(preferredPlacement);

  return {
    placement: preferred.placement,
    left: clamp(preferred.left, VIEWPORT_PADDING, maxLeft),
    top: clamp(preferred.top, VIEWPORT_PADDING, maxTop),
  };
};

export const OnboardingGuide: React.FC = () => {
  const { t } = useTranslation();
  const {
    mode,
    isLeftOpen,
    isRightOpen,
    setMode,
    setLeftPanelOpen,
    setRightPanelOpen,
  } = useAppStore(
    useShallow((state) => ({
      mode: state.mode,
      isLeftOpen: state.isLeftPanelOpen,
      isRightOpen: state.isRightPanelOpen,
      setMode: state.setMode,
      setLeftPanelOpen: state.setLeftPanelOpen,
      setRightPanelOpen: state.setRightPanelOpen,
    }))
  );

  const [isOpen, setIsOpen] = useState(false);
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [targetMeasurement, setTargetMeasurement] = useState<TourTargetMeasurement | null>(null);
  const [targetStatus, setTargetStatus] = useState<'pending' | 'ready' | 'missing'>('pending');
  const [panelSize, setPanelSize] = useState<PanelSize>({ width: 368, height: 300 });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const preferenceLoadedRef = useRef(false);
  const tourOriginRef = useRef<TourOriginState | null>(null);

  const activeStep = TOUR_STEPS[activeStepIndex] ?? TOUR_STEPS[0];
  const firstStepBySection = useMemo(() => {
    const result = new Map<TourSection, number>();
    TOUR_STEPS.forEach((step, index) => {
      if (!result.has(step.section)) {
        result.set(step.section, index);
      }
    });
    return result;
  }, []);
  const sectionProgress = useMemo(() => {
    const sectionSteps = TOUR_STEPS.filter((step) => step.section === activeStep.section);
    const currentIndex = sectionSteps.findIndex((step) => step.id === activeStep.id);
    return {
      current: currentIndex + 1,
      total: sectionSteps.length,
    };
  }, [activeStep.id, activeStep.section]);
  const activeStepPoints = useMemo(
    () =>
      Array.from({ length: activeStep.pointCount ?? 0 }, (_, index) => ({
        key: getStepTranslationKey(activeStep.id, `points.${index}`),
        id: `${activeStep.id}-${index}`,
      })),
    [activeStep.id, activeStep.pointCount]
  );
  const isFirstStep = activeStepIndex === 0;
  const isLastStep = activeStepIndex === TOUR_STEPS.length - 1;
  const stepNumber = activeStepIndex + 1;
  const progressPercent = (stepNumber / TOUR_STEPS.length) * 100;

  const previousStep = useCallback(() => {
    setActiveStepIndex((current) => Math.max(0, current - 1));
  }, []);

  const captureTourOrigin = useCallback(() => {
    const appState = useAppStore.getState();
    tourOriginRef.current = {
      mode: appState.mode,
      isLeftOpen: appState.isLeftPanelOpen,
      isRightOpen: appState.isRightPanelOpen,
    };
  }, []);

  const restoreTourOrigin = useCallback(() => {
    const origin = tourOriginRef.current;
    if (!origin) return;
    tourOriginRef.current = null;
    setMode(origin.mode);
    setLeftPanelOpen(origin.isLeftOpen);
    setRightPanelOpen(origin.isRightOpen);
  }, [setLeftPanelOpen, setMode, setRightPanelOpen]);

  const completeTour = useCallback(async (lastStepId: string) => {
    setIsOpen(false);
    restoreTourOrigin();
    await savePreference(PREF_KEYS.ONBOARDING_STATE, {
      version: ONBOARDING_VERSION,
      completedAt: new Date().toISOString(),
      dismissedAt: null,
      lastStepId,
    } satisfies OnboardingPreferenceState);
  }, [restoreTourOrigin]);

  const nextStep = useCallback(() => {
    if (isLastStep) {
      void completeTour(activeStep.id);
      return;
    }

    setActiveStepIndex((current) => Math.min(TOUR_STEPS.length - 1, current + 1));
  }, [activeStep.id, completeTour, isLastStep]);

  const dismissTour = useCallback(async () => {
    setIsOpen(false);
    restoreTourOrigin();
    await savePreference(PREF_KEYS.ONBOARDING_STATE, {
      version: ONBOARDING_VERSION,
      completedAt: null,
      dismissedAt: new Date().toISOString(),
      lastStepId: activeStep.id,
    } satisfies OnboardingPreferenceState);
  }, [activeStep.id, restoreTourOrigin]);

  useEffect(() => {
    if (preferenceLoadedRef.current) {
      return;
    }

    preferenceLoadedRef.current = true;
    let cancelled = false;

    void loadPreference<OnboardingPreferenceState>(PREF_KEYS.ONBOARDING_STATE)
      .then((state) => {
        if (cancelled) {
          return;
        }

        const isCurrentVersion = state?.version === ONBOARDING_VERSION;
        const shouldStart =
          !isCurrentVersion ||
          (!state.completedAt && !state.dismissedAt);

        if (shouldStart) {
          captureTourOrigin();
          setIsOpen(true);
        } else if (state.lastStepId) {
          const restoredIndex = TOUR_STEPS.findIndex((step) => step.id === state.lastStepId);
          if (restoredIndex >= 0) {
            setActiveStepIndex(restoredIndex);
          }
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [captureTourOrigin]);

  useEffect(() => {
    const handleStart = () => {
      captureTourOrigin();
      setActiveStepIndex(0);
      setIsOpen(true);
    };

    window.addEventListener('macro:start-onboarding', handleStart);
    return () => window.removeEventListener('macro:start-onboarding', handleStart);
  }, [captureTourOrigin]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void dismissTour();
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        nextStep();
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        previousStep();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dismissTour, isOpen, nextStep, previousStep]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    if (activeStep.mode && activeStep.mode !== mode) {
      setMode(activeStep.mode);
    }

    if (activeStep.openLeft && !isLeftOpen) {
      setLeftPanelOpen(true);
    }

    if (activeStep.openRight && !isRightOpen) {
      setRightPanelOpen(true);
    }
  }, [
    activeStep,
    isLeftOpen,
    isOpen,
    isRightOpen,
    mode,
    setLeftPanelOpen,
    setMode,
    setRightPanelOpen,
  ]);

  useEffect(() => {
    if (!panelRef.current) {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setPanelSize({
        width: Math.ceil(entry.contentRect.width),
        height: Math.ceil(entry.contentRect.height),
      });
    });

    resizeObserver.observe(panelRef.current);
    return () => resizeObserver.disconnect();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setTargetMeasurement(null);
      setTargetStatus('pending');
      return;
    }

    let cancelled = false;
    let cleanupGeometry: (() => void) | null = null;
    let requestId = 0;

    const measureAndObserve = async () => {
      const currentRequestId = requestId + 1;
      requestId = currentRequestId;
      cleanupGeometry?.();
      cleanupGeometry = null;
      setTargetStatus('pending');

      const measurement = await measureStableTourTarget({
        targetId: activeStep.targetId,
        fallbackTargetId: activeStep.fallbackTargetId,
      });

      if (cancelled || currentRequestId !== requestId) {
        return;
      }

      if (!measurement) {
        setTargetMeasurement(null);
        setTargetStatus('missing');
        cleanupGeometry = observeTourGeometry({
          target: null,
          onChange: () => void measureAndObserve(),
        });
        return;
      }

      setTargetMeasurement(measurement);
      setTargetStatus('ready');
      cleanupGeometry = observeTourGeometry({
        target: measurement.element,
        onChange: () => void measureAndObserve(),
      });
    };

    void measureAndObserve();

    return () => {
      cancelled = true;
      requestId += 1;
      cleanupGeometry?.();
    };
  }, [
    activeStep.fallbackTargetId,
    activeStep.id,
    activeStep.targetId,
    isLeftOpen,
    isOpen,
    isRightOpen,
    mode,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    void savePreference(PREF_KEYS.ONBOARDING_STATE, {
      version: ONBOARDING_VERSION,
      completedAt: null,
      dismissedAt: null,
      lastStepId: activeStep.id,
    } satisfies OnboardingPreferenceState);
  }, [activeStep.id, isOpen]);

  const panelPosition = useMemo(
    () => resolvePanelPosition(targetMeasurement?.rect ?? null, panelSize, activeStep.placement),
    [activeStep.placement, panelSize, targetMeasurement?.rect]
  );

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  const overlayViewport = targetMeasurement?.viewport ?? getTourViewport();

  return createPortal((
    <div className="fixed inset-0 z-[13000] pointer-events-none" aria-live="polite">
      <TourSpotlightOverlay
        rect={targetMeasurement?.rect ?? null}
        viewport={overlayViewport}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-label={t('onboarding.dialogLabel')}
        className="pointer-events-auto fixed w-[min(23rem,calc(100vw-28px))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl transition-[top,left] duration-200 ease-out animate-in fade-in zoom-in-95"
        style={{
          top: panelPosition.top,
          left: panelPosition.left,
        }}
        data-tour-placement={panelPosition.placement}
      >
        <div className="mx-4 mt-3 h-1.5 rounded-full bg-muted/60 overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="space-y-4 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                <Icon name={activeStep.icon} size={16} />
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(SECTION_LABEL_KEYS[activeStep.section])}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {stepNumber}/{TOUR_STEPS.length}
                  </span>
                </div>
                <h2 className="text-base font-semibold leading-6 text-foreground">
                  {t(getStepTranslationKey(activeStep.id, 'title'))}
                </h2>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void dismissTour()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              aria-label={t('common.close', 'Close')}
              title={t('common.close', 'Close')}
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t(getStepTranslationKey(activeStep.id, 'body'))}
            </p>

            {activeStepPoints.length > 0 && (
              <ul className="space-y-1.5">
                {activeStepPoints.map((point) => (
                  <li key={point.id} className="flex gap-2 text-xs leading-5 text-foreground/90">
                    <Icon name="check" size={12} className="mt-0.5 shrink-0 text-primary" />
                    <span>{t(point.key)}</span>
                  </li>
                ))}
              </ul>
            )}

            {targetMeasurement?.usedFallback && (
              <div className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs leading-5 text-primary">
                {t('onboarding.fallbackTarget')}
              </div>
            )}

            {targetStatus === 'missing' && (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-400">
                {t('onboarding.targetMissing')}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {Array.from(firstStepBySection.entries()).map(([section, index]) => (
              <button
                key={section}
                type="button"
                onClick={() => setActiveStepIndex(index)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide transition-colors',
                  section === activeStep.section
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                {t(SECTION_LABEL_KEYS[section])}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
            <div className="text-[11px] text-muted-foreground">
              {t('onboarding.sectionProgress', {
                current: sectionProgress.current,
                total: sectionProgress.total,
              })}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={previousStep}
                disabled={isFirstStep}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                <Icon name="chevron-left" size={12} />
                {t('common.previous', 'Previous')}
              </button>
              <button
                type="button"
                onClick={nextStep}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                {isLastStep ? t('common.finish', 'Finish') : t('common.next', 'Next')}
                {!isLastStep && <Icon name="chevron-right" size={12} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  ), document.body);
};

export default OnboardingGuide;
