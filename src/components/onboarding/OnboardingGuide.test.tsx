import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  clearPreferences,
  loadPersistedPreference,
  PREF_KEYS,
  savePreference,
} from '../../services/preferences';
import type { AppMode } from '../../types';

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
  Reflect.deleteProperty(window as Window & { visualViewport?: VisualViewport }, 'visualViewport');
  listeners = new Set();
  storeSnapshot = {
    mode: 'Implement',
    isLeftPanelOpen: true,
    isRightPanelOpen: true,
    setMode: (mode) => setStorePatch({ mode }),
    setLeftPanelOpen: (open) => setStorePatch({ isLeftPanelOpen: open }),
    setRightPanelOpen: (open) => setStorePatch({ isRightPanelOpen: open }),
  };
};

mock.module('../../stores/useAppStore', () => ({
  useAppStore: <T,>(selector: (state: AppStoreSnapshot) => T): T =>
    React.useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => selector(storeSnapshot),
      () => selector(storeSnapshot)
    ),
}));

const testTranslations: Record<string, string> = {
  'onboarding.dialogLabel': 'Guide d onboarding',
  'onboarding.fallbackTarget': 'La cible exacte est indisponible dans cet état. Le guide met en avant la zone de contexte la plus proche.',
  'onboarding.targetMissing': 'Cette zone peut être masquée par la taille de fenêtre ou un état vide.',
  'onboarding.sectionProgress': '{{current}}/{{total}} dans cette section',
  'onboarding.sections.basics': 'Bases',
  'onboarding.sections.architect': 'Architect',
  'onboarding.sections.implement': 'Implement',
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
      const translated = testTranslations[key] ?? fallback;

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
          <div data-tour-id="app-shell" />
          <div data-tour-id="mode-switcher" />
          <div data-tour-id="mode-context-header" />
          <button data-tour-id="toggle-right-panel" type="button">Right panel</button>
          {snapshot.mode === 'Architect' ? (
            <div data-tour-id="mode-architect" />
          ) : null}
          {snapshot.isLeftPanelOpen ? (
            <div data-tour-id="left-panel" />
          ) : null}
          {snapshot.isRightPanelOpen ? (
            <div data-tour-id="right-panel" />
          ) : null}
          <button data-tour-id="onboarding-help" type="button">Help</button>
          <button data-tour-id="settings-button" type="button">Settings</button>
          <OnboardingGuide />
        </>
      );
    };

    root = createRoot(container!);
    await act(async () => {
      root?.render(<TestShell />);
    });

    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-tour-id]'));
    targets.forEach((target, index) => {
      setRect(target, makeRect(40 + index * 20, 50 + index * 10, 120, 32));
    });

    act(() => {
      window.dispatchEvent(new Event('macro:start-onboarding'));
    });
    await flushFrames();
  };

  it('measures the target after a step changes the active mode', async () => {
    await renderGuideWithShell();

    clickByText('Next');
    clickByText('Next');
    clickByText('Next');
    clickByText('Next');
    await flushFrames();

    expect(storeSnapshot.mode).toBe('Architect');
    expect(document.querySelector('[data-tour-id="mode-architect"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Cette zone peut être masquée');
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

    clickByText('Next');
    clickByText('Next');
    await flushFrames();

    const panelToggle = document.querySelector<HTMLElement>('[data-tour-id="toggle-right-panel"]');
    act(() => {
      if (panelToggle) {
        panelToggle.style.display = 'none';
      }
      window.dispatchEvent(new Event('resize'));
    });
    await flushFrames(8);

    expect(document.body.textContent).toContain('zone de contexte la plus proche');
    expect(document.body.textContent).not.toContain('Cette zone peut être masquée');
  });

  it('persists dismissed and completed onboarding state', async () => {
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
  });
});
