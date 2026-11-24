import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fr from '../../i18n/locales/fr.json';
import agsdlFr from '../../i18n/locales/segments/agsdl-fr.json';
import { demoWorkflowJourney } from '../../services/operateWorkspace';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  clearPreferences,
  loadPersistedPreference,
  PREF_KEYS,
  savePreference,
} from '../../services/preferences';
import type { AppMode } from '../../types';

let frenchSteps = false;

type AppStoreSnapshot = {
  mode: AppMode;
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  setMode: (mode: AppMode) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
};

let storeSnapshot: AppStoreSnapshot;
let listeners = new Set<() => void>();

const notifyStoreListeners = () => {
  listeners.forEach((listener) => listener());
};

const setStorePatch = (patch: Partial<AppStoreSnapshot>) => {
  storeSnapshot = {
    ...storeSnapshot,
    ...patch,
  };
  notifyStoreListeners();
};

const resetStore = () => {
  frenchSteps = false;
  Reflect.deleteProperty(window as Window & { visualViewport?: VisualViewport }, 'visualViewport');
  listeners = new Set();
  storeSnapshot = {
    mode: 'Implement',
    isLeftPanelOpen: false,
    isRightPanelOpen: false,
    setMode: (mode) => setStorePatch({ mode }),
    setLeftPanelOpen: (open) => setStorePatch({ isLeftPanelOpen: open }),
    setRightPanelOpen: (open) => setStorePatch({ isRightPanelOpen: open }),
  };
};

const mockedUseAppStore = Object.assign(
  <T,>(selector: (state: AppStoreSnapshot) => T): T =>
    React.useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => selector(storeSnapshot),
      () => selector(storeSnapshot)
    ),
  { getState: () => storeSnapshot }
);

mock.module('../../stores/useAppStore', () => ({ useAppStore: mockedUseAppStore }));

const testTranslations: Record<string, string> = {
  'onboarding.dialogLabel': 'Guide d onboarding',
  'onboarding.fallbackTarget': 'La cible exacte est indisponible dans cet état. Le guide met en avant la zone de contexte la plus proche.',
  'onboarding.targetMissing': 'Cette zone peut être masquée par la taille de fenêtre ou un état vide.',
  'onboarding.sectionProgress': '{{current}}/{{total}} dans cette section',
  'onboarding.sections.basics': 'Bases',
  'onboarding.sections.architect': 'Architect',
  'onboarding.sections.operate': 'Operate',
  'onboarding.sections.chat': 'Chat',
  'onboarding.sections.system': 'Système',
};

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallbackOrValues?: string | Record<string, unknown>,
      interpolationValues?: Record<string, unknown>
    ) => {
      const values =
        typeof fallbackOrValues === 'object' ? fallbackOrValues : interpolationValues;
      const fallback = typeof fallbackOrValues === 'string' ? fallbackOrValues : key;
      const frenchValue = key.startsWith('onboarding.steps.')
        ? key.split('.').reduce<unknown>((value, segment) => value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined, fr)
        : undefined;
      const translated = frenchSteps && typeof frenchValue === 'string' ? frenchValue : testTranslations[key] ?? fallback;

      if (!values) {
        return translated;
      }

      return Object.entries(values).reduce(
        (label, [key, value]) => label.replace(`{{${key}}}`, String(value)),
        translated
      );
    },
  }),
}));

const makeRect = (
  left: number,
  top: number,
  width: number,
  height: number
): DOMRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
} as DOMRect);

const setRect = (element: HTMLElement, rect: DOMRect) => {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  });
};

const flushFrames = async (count = 6) => {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
  }
};

const clickByText = (text: string) => {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(text)
  );
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  act(() => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
};

const findButtonByText = (text: string): HTMLButtonElement | null =>
  Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(text)
  ) ?? null;

describe('tourGeometry', () => {
  beforeEach(() => {
    resetStore();
  });

  it('prefers the visible primary target over fallback', async () => {
    const { resolveTourTarget } = await import('./tourGeometry');
    const primary = document.createElement('div');
    const fallback = document.createElement('div');
    primary.dataset.tourId = 'primary';
    fallback.dataset.tourId = 'fallback';
    setRect(primary, makeRect(100, 100, 80, 30));
    setRect(fallback, makeRect(200, 200, 80, 30));
    document.body.append(primary, fallback);

    expect(resolveTourTarget({ targetId: 'primary', fallbackTargetId: 'fallback' })?.element).toBe(primary);
  });

  it('uses fallback when the primary target is hidden', async () => {
    const { resolveTourTarget } = await import('./tourGeometry');
    const primary = document.createElement('div');
    const fallback = document.createElement('div');
    primary.dataset.tourId = 'primary';
    fallback.dataset.tourId = 'fallback';
    primary.style.display = 'none';
    setRect(primary, makeRect(100, 100, 80, 30));
    setRect(fallback, makeRect(200, 200, 80, 30));
    document.body.append(primary, fallback);

    const resolution = resolveTourTarget({ targetId: 'primary', fallbackTargetId: 'fallback' });
    expect(resolution?.element).toBe(fallback);
    expect(resolution?.usedFallback).toBe(true);
  });

  it('skips unusable duplicates and returns the first connected visible target', async () => {
    const { resolveTourTarget } = await import('./tourGeometry');
    const hidden = document.createElement('div');
    const visible = document.createElement('div');
    hidden.dataset.tourId = 'duplicate';
    visible.dataset.tourId = 'duplicate';
    hidden.style.visibility = 'hidden';
    setRect(hidden, makeRect(100, 100, 80, 30));
    setRect(visible, makeRect(240, 120, 80, 30));
    document.body.append(hidden, visible);

    expect(resolveTourTarget({ targetId: 'duplicate' })?.element).toBe(visible);
  });

  it('chooses the visible duplicate with the largest viewport intersection', async () => {
    const { resolveTourTarget } = await import('./tourGeometry');
    const tiny = document.createElement('div');
    const large = document.createElement('div');
    tiny.dataset.tourId = 'duplicate';
    large.dataset.tourId = 'duplicate';
    setRect(tiny, makeRect(5, 5, 20, 20));
    setRect(large, makeRect(240, 120, 180, 80));
    document.body.append(tiny, large);

    expect(resolveTourTarget({ targetId: 'duplicate' })?.element).toBe(large);
  });

  it('pads and clamps target rectangles near viewport edges', async () => {
    const { toOverlayRect } = await import('./tourGeometry');
    const rect = toOverlayRect(makeRect(2, 3, 40, 20));

    expect(rect.left).toBe(1);
    expect(rect.top).toBe(1);
    expect(rect.width).toBe(47);
    expect(rect.height).toBe(28);
  });

  it('keeps header targets aligned near the top edge', async () => {
    const { toOverlayRect } = await import('./tourGeometry');
    const rect = toOverlayRect(makeRect(496.5, 8, 287, 28));

    expect(rect.left).toBe(491);
    expect(rect.top).toBe(2);
    expect(rect.width).toBe(299);
    expect(rect.height).toBe(40);
  });

  it('converts visualViewport offset into overlay coordinates', async () => {
    const { toOverlayRect } = await import('./tourGeometry');
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 800,
        height: 600,
        offsetLeft: 30,
        offsetTop: 40,
        scale: 1.25,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });

    const rect = toOverlayRect(makeRect(130, 160, 100, 50), {
      padding: 0,
      viewportPadding: 0,
    });

    expect(rect.left).toBe(100);
    expect(rect.top).toBe(120);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(50);
  });

  it('waits until a moving target converges before returning stable geometry', async () => {
    const { measureStableTourTarget } = await import('./tourGeometry');
    const target = document.createElement('div');
    target.dataset.tourId = 'moving';
    document.body.append(target);
    target.scrollIntoView = () => undefined;
    const rects = [
      makeRect(100, 100, 80, 30),
      makeRect(104, 100, 80, 30),
      makeRect(108, 100, 80, 30),
      makeRect(108, 100, 80, 30),
      makeRect(108, 100, 80, 30),
      makeRect(108, 100, 80, 30),
    ];
    Object.defineProperty(target, 'getBoundingClientRect', {
      configurable: true,
      value: () => rects.shift() ?? makeRect(108, 100, 80, 30),
    });

    const measurementPromise = measureStableTourTarget(
      { targetId: 'moving' },
      { stableFrames: 3, timeoutMs: 500 }
    );
    await flushFrames(8);
    const measurement = await measurementPromise;

    expect(measurement?.stable).toBe(true);
    expect(measurement?.rect.left).toBe(102);
  });

  it('scrolls an offscreen target before requiring viewport intersection', async () => {
    const { measureStableTourTarget } = await import('./tourGeometry');
    const target = document.createElement('div');
    let scrolled = false;
    target.dataset.tourId = 'offscreen';
    target.scrollIntoView = () => {
      scrolled = true;
    };
    Object.defineProperty(target, 'getBoundingClientRect', {
      configurable: true,
      value: () => scrolled ? makeRect(120, 140, 100, 40) : makeRect(4000, 4000, 100, 40),
    });
    document.body.append(target);

    const measurementPromise = measureStableTourTarget(
      { targetId: 'offscreen' },
      { stableFrames: 2, timeoutMs: 500 }
    );
    await flushFrames(6);
    const measurement = await measurementPromise;

    expect(scrolled).toBe(true);
    expect(measurement?.rect.left).toBe(114);
  });
});

describe('OnboardingGuide positioning', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    resetStore();
    await clearPreferences();
    await savePreference(PREF_KEYS.ONBOARDING_STATE, {
      version: 1,
      completedAt: '2026-01-01T00:00:00.000Z',
      dismissedAt: null,
      lastStepId: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    HTMLElement.prototype.scrollIntoView = () => undefined;
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
  });

  const positionTarget = (left: number) => (node: HTMLElement | null) => {
    if (node) setRect(node, makeRect(left, 60, 120, 32));
  };

  const renderGuideWithShell = async () => {
    const { OnboardingGuide } = await import('./OnboardingGuide');
    const TestShell = () => {
      const snapshot = React.useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => storeSnapshot,
        () => storeSnapshot
      );

      return (
        <>
          <div data-tour-id="app-shell" ref={positionTarget(40)} />
          <div data-tour-id="mode-switcher" ref={positionTarget(60)}>
            <button data-tour-id="mode-architect" ref={positionTarget(80)} type="button" />
            <button data-tour-id="mode-chat" ref={positionTarget(100)} type="button" />
          </div>
          <button data-tour-id="toggle-left-panel" ref={positionTarget(120)} type="button" />
          {snapshot.mode === 'Architect' && (
            <>
              {snapshot.isLeftPanelOpen && <aside data-tour-id="architect-project-navigator" ref={positionTarget(160)} />}
              <header data-tour-id="mode-context-header" ref={positionTarget(180)} />
              {snapshot.isRightPanelOpen && <aside data-tour-id="architect-agsdl-panel" ref={positionTarget(200)} />}
            </>
          )}
          {snapshot.mode === 'Implement' && snapshot.isLeftPanelOpen && (
            <nav data-tour-id="operate-executions" ref={positionTarget(220)} />
          )}
          {snapshot.mode === 'Chat' && (
            <>
              {snapshot.isLeftPanelOpen && <aside data-tour-id="chat-conversations-panel" ref={positionTarget(240)} />}
              {snapshot.isRightPanelOpen && <aside data-tour-id="chat-toolbox-panel" ref={positionTarget(260)} />}
              <div data-tour-id="chat-control-row" ref={positionTarget(280)} />
              <div data-tour-id="chat-composer" ref={positionTarget(300)} />
            </>
          )}
          <footer data-tour-id="footer-status-bar" ref={positionTarget(320)}>
            <button data-tour-id="notification-center" ref={positionTarget(340)} type="button">Notifications</button>
          </footer>
          <button data-tour-id="onboarding-help" ref={positionTarget(360)} type="button">Help</button>
          <button data-tour-id="settings-button" ref={positionTarget(380)} type="button">Settings</button>
          <OnboardingGuide />
        </>
      );
    };

    root = createRoot(container!);
    await act(async () => {
      root?.render(<TestShell />);
    });

    act(() => {
      window.dispatchEvent(new Event('macro:start-onboarding'));
    });
    await flushFrames();
  };

  it('anchors the French tour to the current Architect, Operate, Chat and notification targets', async () => {
    frenchSteps = true;
    await renderGuideWithShell();
    const expectedSteps = [
      ['welcome', 'app-shell', 'Implement'],
      ['modes', 'mode-switcher', 'Implement'],
      ['panel-toggles', 'toggle-left-panel', 'Implement'],
      ['settings-and-help', 'settings-button', 'Implement'],
      ['architect-mode', 'mode-architect', 'Architect'],
      ['architect-navigator', 'architect-project-navigator', 'Architect'],
      ['architect-conversation', 'mode-context-header', 'Architect'],
      ['architect-agsdl', 'architect-agsdl-panel', 'Architect'],
      ['operate-executions', 'operate-executions', 'Implement'],
      ['chat-mode', 'mode-chat', 'Chat'],
      ['chat-conversations', 'chat-conversations-panel', 'Chat'],
      ['chat-toolbox', 'chat-toolbox-panel', 'Chat'],
      ['chat-models', 'chat-control-row', 'Chat'],
      ['composer', 'chat-composer', 'Chat'],
      ['footer', 'notification-center', 'Chat'],
      ['done', 'onboarding-help', 'Chat'],
    ] as const;

    for (const [step, targetId, mode] of expectedSteps) {
      const tour = document.querySelector('[role="dialog"]');
      expect(tour?.querySelector('h2')?.textContent).toBe(fr.onboarding.steps[step].title);
      const expectedBody = demoWorkflowJourney && step === 'operate-executions'
        ? fr.onboarding.steps[step].demoBody
        : fr.onboarding.steps[step].body;
      expect(tour?.textContent).toContain(expectedBody);
      expect(tour?.textContent).not.toContain(testTranslations['onboarding.fallbackTarget']);
      expect(tour?.textContent).not.toContain(testTranslations['onboarding.targetMissing']);
      expect(storeSnapshot.mode).toBe(mode);

      const target = document.querySelector(`[data-tour-id="${targetId}"]`)!;
      const highlight = document.querySelector('[data-onboarding-highlight="true"]');
      expect(highlight?.getAttribute('x')).toBe(String(target.getBoundingClientRect().left - 6));

      if (step === 'architect-agsdl') expect(tour?.textContent).toContain(agsdlFr.expand);
      if (step === 'chat-toolbox') expect(tour?.textContent).toContain(fr.chat.toolbox);
      if (step === 'chat-models') expect(tour?.textContent).toContain('une clé dans Paramètres');
      if (step === 'composer') {
        expect(tour?.textContent).toContain('Le bouton Arrêter interrompt le tour actif.');
        expect(tour?.textContent).toContain('mettre le message en file');
      }
      if (step !== 'done') {
        clickByText('Next');
        await flushFrames();
      }
    }
  });

  it('keeps header step highlights anchored near the viewport edge', async () => {
    await renderGuideWithShell();
    const modeSwitcher = document.querySelector<HTMLElement>('[data-tour-id="mode-switcher"]');
    expect(modeSwitcher).not.toBeNull();

    setRect(modeSwitcher!, makeRect(121, 10, 131, 28));
    clickByText('Next');
    await flushFrames(8);

    const highlight = document.querySelector<SVGRectElement>('[data-onboarding-highlight="true"]');
    expect(highlight?.getAttribute('x')).toBe('115');
    expect(highlight?.getAttribute('y')).toBe('4');
    expect(highlight?.getAttribute('width')).toBe('143');
    expect(highlight?.getAttribute('height')).toBe('40');
  });

  it('opens only the left panel when jumping to Operate', async () => {
    setStorePatch({ mode: 'Chat' });
    await renderGuideWithShell();

    clickByText('Operate');
    await flushFrames();

    expect(storeSnapshot).toMatchObject({
      mode: 'Implement',
      isLeftPanelOpen: true,
      isRightPanelOpen: false,
    });
    const highlight = document.querySelector('[data-onboarding-highlight="true"]');
    expect(highlight?.getAttribute('x')).toBe('214');
  });

  it('remeasures when a visible target moves on resize', async () => {
    await renderGuideWithShell();
    const target = document.querySelector<HTMLElement>('[data-tour-id="app-shell"]');
    expect(target).not.toBeNull();

    setRect(target!, makeRect(300, 220, 120, 40));
    window.dispatchEvent(new Event('resize'));
    await flushFrames(2);

    const highlight = document.querySelector<SVGRectElement>('[data-onboarding-highlight="true"]');
    expect(highlight?.getAttribute('x')).toBe('294');
    expect(highlight?.getAttribute('y')).toBe('214');
  });

  it('surfaces fallback usage distinctly from a missing target', async () => {
    await renderGuideWithShell();

    clickByText('Architect');
    await flushFrames();

    const architectButton = document.querySelector<HTMLElement>('[data-tour-id="mode-architect"]')!;
    act(() => {
      architectButton.style.display = 'none';
      window.dispatchEvent(new Event('resize'));
    });
    await flushFrames(8);

    expect(document.body.textContent).toContain('zone de contexte la plus proche');
    expect(document.body.textContent).not.toContain('Cette zone peut être masquée');
  });

  it('persists dismissed and completed onboarding state', async () => {
    const origin = {
      mode: storeSnapshot.mode,
      isLeftPanelOpen: storeSnapshot.isLeftPanelOpen,
      isRightPanelOpen: storeSnapshot.isRightPanelOpen,
    };
    await renderGuideWithShell();

    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const dismissed = await loadPersistedPreference<{
      dismissedAt: string | null;
      completedAt: string | null;
    }>(PREF_KEYS.ONBOARDING_STATE);
    expect(dismissed?.dismissedAt).toBeTruthy();
    expect(dismissed?.completedAt).toBeNull();
    expect(storeSnapshot).toMatchObject(origin);

    act(() => {
      window.dispatchEvent(new Event('macro:start-onboarding'));
    });
    await flushFrames();
    for (let index = 0; index < 30 && findButtonByText('Next'); index += 1) {
      clickByText('Next');
      await flushFrames(1);
    }
    clickByText('Finish');
    await act(async () => {
      await Promise.resolve();
    });

    const completed = await loadPersistedPreference<{
      dismissedAt: string | null;
      completedAt: string | null;
    }>(PREF_KEYS.ONBOARDING_STATE);
    expect(completed?.completedAt).toBeTruthy();
    expect(completed?.dismissedAt).toBeNull();
    expect(storeSnapshot).toMatchObject(origin);
  });
});
