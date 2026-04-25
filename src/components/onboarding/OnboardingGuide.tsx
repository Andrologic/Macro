import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { loadPreference, PREF_KEYS, savePreference } from '../../services/preferences';
import { useAppStore } from '../../stores/useAppStore';
import type { AppMode } from '../../types';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';

const ONBOARDING_VERSION = 1;
const TARGET_PADDING = 6;
const PANEL_GAP = 14;
const VIEWPORT_PADDING = 14;

type TourSection = 'basics' | 'architect' | 'implement' | 'chat' | 'system';
type TourPlacement = 'top' | 'right' | 'bottom' | 'left' | 'center';

interface OnboardingPreferenceState {
  version: number;
  completedAt: string | null;
  dismissedAt: string | null;
  lastStepId: string | null;
}

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
  title: string;
  body: string;
  points?: string[];
}

interface TourTargetRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
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

const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    section: 'basics',
    targetId: 'app-shell',
    placement: 'center',
    icon: 'sparkles',
    title: 'Bienvenue dans Macro',
    body: 'Macro est organise par modes. Le meilleur onboarding consiste a montrer les controles quand ils deviennent utiles, puis a laisser l utilisateur reprendre la main.',
    points: [
      'Le guide change de mode automatiquement.',
      'Les panneaux gauche et droit sont rouverts quand une etape en a besoin.',
      'Tu peux le relancer a tout moment depuis le bouton livre en haut.',
    ],
  },
  {
    id: 'modes',
    section: 'basics',
    targetId: 'mode-switcher',
    placement: 'bottom',
    icon: 'compass',
    title: 'Le selecteur de mode',
    body: 'Ces trois boutons changent completement la surface de travail. Architect sert a cadrer, Implement a executer, Chat a discuter avec contexte libre.',
    points: [
      'Architect : besoins, plans et strategie.',
      'Implement : taches, terminal et validation des changements.',
      'Chat : conversations, sources et outils generaux.',
    ],
  },
  {
    id: 'project-picker',
    section: 'basics',
    mode: 'Implement',
    targetId: 'project-picker',
    fallbackTargetId: 'mode-context-header',
    placement: 'bottom',
    icon: 'folder-git-2',
    title: 'Projet actif',
    body: 'Ce bouton ouvre le navigateur de projets. Il determine les repos, les branches et le contexte utilises par Architect et Implement.',
  },
  {
    id: 'panel-toggles',
    section: 'basics',
    targetId: 'toggle-right-panel',
    fallbackTargetId: 'mode-context-header',
    placement: 'bottom',
    icon: 'panel-right-open',
    title: 'Panneaux lateraux',
    body: 'Les boutons de panneau masquent ou affichent les zones de contexte. Le panneau gauche contient souvent la liste de travail, le panneau droit les details ou validations.',
  },
  {
    id: 'settings-and-help',
    section: 'basics',
    targetId: 'settings-button',
    placement: 'bottom',
    icon: 'settings',
    title: 'Reglages et onboarding',
    body: 'Les reglages regroupent fournisseurs IA, modeles, securite des outils, themes et raccourcis. Le bouton livre juste a cote relance ce guide.',
  },
  {
    id: 'architect-mode',
    section: 'architect',
    mode: 'Architect',
    targetId: 'mode-architect',
    fallbackTargetId: 'mode-switcher',
    openLeft: true,
    openRight: true,
    placement: 'bottom',
    icon: 'compass',
    title: 'Mode Architect',
    body: 'Architect transforme une discussion en besoins, puis en strategie de branches et de taches. C est le mode a utiliser avant de coder quand le cadrage est encore flou.',
  },
  {
    id: 'architect-plan-selector',
    section: 'architect',
    mode: 'Architect',
    targetId: 'architect-plan-selector',
    fallbackTargetId: 'mode-context-header',
    openLeft: true,
    openRight: true,
    placement: 'bottom',
    icon: 'layers',
    title: 'Plans',
    body: 'Le selecteur de plan isole les conversations, besoins et strategies. Tu peux creer un plan feature, release, hotfix ou bugfix selon le flux Git attendu.',
  },
  {
    id: 'architect-needs',
    section: 'architect',
    mode: 'Architect',
    targetId: 'architect-needs-panel',
    fallbackTargetId: 'left-panel',
    openLeft: true,
    openRight: true,
    placement: 'right',
    icon: 'list',
    title: 'Besoins identifies',
    body: 'Le panneau gauche liste les besoins extraits ou affines pendant la conversation Architect. Les filtres par categorie evitent de tout relire quand le plan grossit.',
  },
  {
    id: 'architect-generate',
    section: 'architect',
    mode: 'Architect',
    targetId: 'architect-generate-strategy',
    fallbackTargetId: 'chat-control-row',
    openLeft: true,
    openRight: true,
    placement: 'top',
    icon: 'sparkles',
    title: 'Generer la strategie',
    body: 'Ce bouton est l action importante d Architect. Il convertit les besoins en graphe de taches et en branches previsibles, uniquement quand le contexte est suffisant.',
  },
  {
    id: 'architect-strategy',
    section: 'architect',
    mode: 'Architect',
    targetId: 'architect-strategy-panel',
    fallbackTargetId: 'right-panel',
    openLeft: true,
    openRight: true,
    placement: 'left',
    icon: 'network',
    title: 'Strategie et branches',
    body: 'Le panneau droit montre la strategie. Le switch Graph / Branches aide a passer d une vue dependances a une vue execution Git.',
    points: [
      'Graph : dependances et ordre logique.',
      'Branches : travail regroupe par branche fonctionnelle.',
      'Expand ouvre un explorateur plus confortable.',
    ],
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
    title: 'Valider le plan',
    body: 'La validation fige le plan suffisamment pour provisionner les branches et alimenter Implement. Les taches demarrees ou terminees sont protegees contre les regenerations destructrices.',
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
    title: 'Mode Implement',
    body: 'Implement sert a prendre une tache, discuter son execution, ouvrir un terminal et valider les fichiers modifies avant commit.',
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
    title: 'File de taches',
    body: 'Le panneau gauche trie les taches par etat. Le plus cree une feature independante, le bouton archive affiche ou masque les anciennes taches.',
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
    title: 'Plan ou Build',
    body: 'Dans Implement, ce controle choisit le comportement de l agent. Plan sert a preparer ou clarifier, Build sert a modifier le code et executer.',
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
    title: 'Terminal de tache',
    body: 'Le terminal s ouvre dans le contexte de la tache et du repo selectionnes. S il y a plusieurs sous-projets, Macro peut demander lequel cibler.',
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
    title: 'Validation des changements',
    body: 'Le panneau droit suit les fichiers modifies par repo. Valider stage les changements acceptes, Commit enregistre ce qui est pret, et Finish termine la tache quand tout est resolu.',
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
    title: 'Mode Chat',
    body: 'Chat est le mode libre. Il garde les conversations separees des plans et taches, mais permet d attacher fichiers, liens, outils et sources.',
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
    title: 'Conversations',
    body: 'Le panneau gauche gere l historique : nouveau chat, recherche, multi-selection, epinglage, archive, export et suppression.',
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
    title: 'Toolbox',
    body: 'Le panneau droit est la boite a contexte. Tu peux joindre des fichiers, ajouter une URL, coller du texte, activer des outils et retrouver les sources citees.',
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
    title: 'Fournisseur, modele et raisonnement',
    body: 'Ces menus choisissent le fournisseur IA, le modele et l effort de raisonnement. Si un bouton est desactive, il faut souvent configurer une cle dans Settings.',
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
    title: 'Composer et envoyer',
    body: 'Le composer accepte texte, mentions et images collees. Le bouton fleche envoie, ou stoppe la generation quand une reponse est en cours.',
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
    title: 'Barre Git et notifications',
    body: 'La barre du bas resume le projet global, les branches, fetch / pull / push et le centre de notifications. C est la zone a regarder quand Macro demande une action de synchro.',
  },
  {
    id: 'done',
    section: 'system',
    targetId: 'onboarding-help',
    fallbackTargetId: 'settings-button',
    placement: 'bottom',
    icon: 'check-circle',
    title: 'Onboarding relancable',
    body: 'Le parcours est termine. Le bouton livre relance ce guide pour revisiter les modes ou expliquer un bouton a quelqu un de nouveau.',
  },
];

const SECTION_LABELS: Record<TourSection, string> = {
  basics: 'Bases',
  architect: 'Architect',
  implement: 'Implement',
  chat: 'Chat',
  system: 'Systeme',
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const isElementVisible = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  );
};

const findTourTarget = (targetId?: string): HTMLElement | null => {
  if (!targetId || typeof document === 'undefined') {
    return null;
  }

  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-tour-id="${targetId}"]`)
  );

  return elements.find(isElementVisible) ?? null;
};

const padRect = (rect: DOMRect): TourTargetRect => {
  const left = clamp(rect.left - TARGET_PADDING, VIEWPORT_PADDING, window.innerWidth - VIEWPORT_PADDING);
  const top = clamp(rect.top - TARGET_PADDING, VIEWPORT_PADDING, window.innerHeight - VIEWPORT_PADDING);
  const right = clamp(rect.right + TARGET_PADDING, VIEWPORT_PADDING, window.innerWidth - VIEWPORT_PADDING);
  const bottom = clamp(rect.bottom + TARGET_PADDING, VIEWPORT_PADDING, window.innerHeight - VIEWPORT_PADDING);

  return {
    top,
    right,
    bottom,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
};

const resolvePanelPosition = (
  targetRect: TourTargetRect | null,
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
  const [targetRect, setTargetRect] = useState<TourTargetRect | null>(null);
  const [hasTarget, setHasTarget] = useState(true);
  const [panelSize, setPanelSize] = useState<PanelSize>({ width: 368, height: 300 });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const preferenceLoadedRef = useRef(false);

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
  const isFirstStep = activeStepIndex === 0;
  const isLastStep = activeStepIndex === TOUR_STEPS.length - 1;
  const stepNumber = activeStepIndex + 1;
  const progressPercent = (stepNumber / TOUR_STEPS.length) * 100;

  const previousStep = useCallback(() => {
    setActiveStepIndex((current) => Math.max(0, current - 1));
  }, []);

  const completeTour = useCallback(async (lastStepId: string) => {
    setIsOpen(false);
    await savePreference(PREF_KEYS.ONBOARDING_STATE, {
      version: ONBOARDING_VERSION,
      completedAt: new Date().toISOString(),
      dismissedAt: null,
      lastStepId,
    } satisfies OnboardingPreferenceState);
  }, []);

  const nextStep = useCallback(() => {
    if (isLastStep) {
      void completeTour(activeStep.id);
      return;
    }

    setActiveStepIndex((current) => Math.min(TOUR_STEPS.length - 1, current + 1));
  }, [activeStep.id, completeTour, isLastStep]);

  const dismissTour = useCallback(async () => {
    setIsOpen(false);
    await savePreference(PREF_KEYS.ONBOARDING_STATE, {
      version: ONBOARDING_VERSION,
      completedAt: null,
      dismissedAt: new Date().toISOString(),
      lastStepId: activeStep.id,
    } satisfies OnboardingPreferenceState);
  }, [activeStep.id]);

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
  }, []);

  useEffect(() => {
    const handleStart = () => {
      setActiveStepIndex(0);
      setIsOpen(true);
    };

    window.addEventListener('macro:start-onboarding', handleStart);
    return () => window.removeEventListener('macro:start-onboarding', handleStart);
  }, []);

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

  useEffect(() => {
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
      setTargetRect(null);
      return;
    }

    let frameId = 0;

    const measure = () => {
      const target =
        findTourTarget(activeStep.targetId) ??
        findTourTarget(activeStep.fallbackTargetId) ??
        null;

      if (!target) {
        setHasTarget(false);
        setTargetRect(null);
        return;
      }

      setHasTarget(true);
      setTargetRect(padRect(target.getBoundingClientRect()));
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(measure);
    };

    const scrollTargetIntoView = () => {
      const target =
        findTourTarget(activeStep.targetId) ??
        findTourTarget(activeStep.fallbackTargetId);
      target?.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'smooth',
      });
      scheduleMeasure();
    };

    const scrollTimeout = window.setTimeout(scrollTargetIntoView, 120);
    const intervalId = window.setInterval(measure, 250);
    const observer = new MutationObserver(scheduleMeasure);

    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'style', 'data-tour-id'],
    });

    measure();
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('scroll', scheduleMeasure, true);

    return () => {
      window.clearTimeout(scrollTimeout);
      window.clearInterval(intervalId);
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', scheduleMeasure, true);
    };
  }, [activeStep.fallbackTargetId, activeStep.targetId, isOpen]);

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
    () => resolvePanelPosition(targetRect, panelSize, activeStep.placement),
    [activeStep.placement, panelSize, targetRect]
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[13000] pointer-events-none" aria-live="polite">
      {targetRect ? (
        <>
          <div
            className="absolute bg-black/55 backdrop-blur-[1px] pointer-events-auto"
            style={{ top: 0, left: 0, right: 0, height: targetRect.top }}
          />
          <div
            className="absolute bg-black/55 backdrop-blur-[1px] pointer-events-auto"
            style={{
              top: targetRect.bottom,
              left: 0,
              right: 0,
              bottom: 0,
            }}
          />
          <div
            className="absolute bg-black/55 backdrop-blur-[1px] pointer-events-auto"
            style={{
              top: targetRect.top,
              left: 0,
              width: targetRect.left,
              height: targetRect.height,
            }}
          />
          <div
            className="absolute bg-black/55 backdrop-blur-[1px] pointer-events-auto"
            style={{
              top: targetRect.top,
              left: targetRect.right,
              right: 0,
              height: targetRect.height,
            }}
          />
          <div
            className="absolute rounded-xl border border-primary/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.08),0_0_0_4px_rgba(99,102,241,0.18),0_20px_45px_-18px_rgba(99,102,241,0.75)] transition-all duration-200"
            style={{
              top: targetRect.top,
              left: targetRect.left,
              width: targetRect.width,
              height: targetRect.height,
            }}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/55 backdrop-blur-[1px] pointer-events-auto" />
      )}

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-label={t('onboarding.dialogLabel', 'Onboarding guide')}
        className="pointer-events-auto fixed w-[min(23rem,calc(100vw-28px))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl transition-[top,left] duration-200"
        style={{
          top: panelPosition.top,
          left: panelPosition.left,
        }}
        data-tour-placement={panelPosition.placement}
      >
        <div className="h-1 bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
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
                    {SECTION_LABELS[activeStep.section]}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {stepNumber}/{TOUR_STEPS.length}
                  </span>
                </div>
                <h2 className="text-base font-semibold leading-6 text-foreground">
                  {activeStep.title}
                </h2>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void dismissTour()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={t('common.close', 'Close')}
              title={t('common.close', 'Close')}
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <div className="space-y-3">
            <p className="text-sm leading-6 text-muted-foreground">
              {activeStep.body}
            </p>

            {activeStep.points && activeStep.points.length > 0 && (
              <ul className="space-y-1.5">
                {activeStep.points.map((point) => (
                  <li key={point} className="flex gap-2 text-xs leading-5 text-foreground/90">
                    <Icon name="check" size={12} className="mt-1 shrink-0 text-primary" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            )}

            {!hasTarget && (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
                {t(
                  'onboarding.targetMissing',
                  'Cette zone peut etre masquee par la taille de fenetre ou un etat vide. Le guide reste dans le bon mode et reprendra l ancrage des que le bouton est visible.'
                )}
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
                  'rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
                  section === activeStep.section
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                {SECTION_LABELS[section]}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="text-[11px] text-muted-foreground">
              {t('onboarding.sectionProgress', '{{current}}/{{total}} dans cette section', {
                current: sectionProgress.current,
                total: sectionProgress.total,
              })}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={previousStep}
                disabled={isFirstStep}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name="chevron-left" size={12} />
                {t('common.previous', 'Previous')}
              </button>
              <button
                type="button"
                onClick={nextStep}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {isLastStep ? t('common.finish', 'Finish') : t('common.next', 'Next')}
                {!isLastStep && <Icon name="chevron-right" size={12} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnboardingGuide;
