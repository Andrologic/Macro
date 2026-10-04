import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslationMock, installReactI18nextMock } from '../../../test-utils/reactI18nextMock';

installReactI18nextMock(createTranslationMock({ 'settings.zoom_level': "Zoom de l'interface" }));
const setZoom = mock(() => undefined);
let mode: 'auto' | 'override' = 'auto';
mock.module('../../../stores/useAppStore', () => ({
  useAppStore: () => ({
    activeThemeId: 'macro-dark', setTheme: () => undefined,
    uiZoomMode: mode, uiZoomLevel: 1, setUiZoomMode: () => undefined, setUiZoomLevel: setZoom,
    codeOverflowMode: 'wrap', setCodeOverflowMode: () => undefined,
  }),
}));
mock.module('./ThemePreview', () => ({ ThemePreview: () => null }));
const { AppearanceView } = await import('./AppearanceView');
let root: Root;
let container: HTMLDivElement;
const originalFetch = globalThis.fetch;
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
});

describe('interface zoom accessibility', () => {
  for (const zoomMode of ['auto', 'override'] as const) {
    it(`associates the visible translated label with the slider in ${zoomMode} mode`, async () => {
      mode = zoomMode;
      globalThis.fetch = mock(async () => new Response(JSON.stringify({ themes: [] }))) as unknown as typeof fetch;
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root.render(<AppearanceView />));
      const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
      const label = container.querySelector<HTMLLabelElement>('label')!;
      expect(label.htmlFor).toBe(slider.id);
      expect(slider.id).not.toBe('');
      expect(label.textContent).toBe("Zoom de l'interface");
      expect(slider.disabled).toBe(zoomMode === 'auto');
      expect(slider.value).toBe('100');
      if (zoomMode === 'override') {
        slider.focus();
        expect(document.activeElement).toBe(slider);
      }
    });
  }
});
