import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const actualPreferences = await import('../../../services/preferences');
const save = mock(async (_values: unknown): Promise<void> => { throw new Error('disk unavailable'); });
const notifyError = mock(() => undefined);
mock.module('../../../services/preferences', () => ({
  ...actualPreferences,
  loadPreference: async () => null,
  savePreferences: save,
}));
mock.module('../../ui/toastService', () => ({ notify: { error: notifyError } }));
const { ArchitectGitFlowView } = await import('./ArchitectGitFlowView');
afterEach(() => mock.restore());

describe('ArchitectGitFlowView persistence', () => {
  it('releases the saving state and allows retry after a failed save', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<ArchitectGitFlowView />); });
      const button = [...container.querySelectorAll('button')].find((item) => /save|enregistrer/i.test(item.textContent ?? ''))!;
      expect(button).toBeDefined();
      await act(async () => { button.click(); });
      expect(notifyError).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(false);
      save.mockImplementationOnce(async () => undefined);
      await act(async () => { button.click(); });
      expect(save).toHaveBeenCalledTimes(2);
      expect(Object.keys(save.mock.calls[0][0] as object)).toHaveLength(10);
      expect(button.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
