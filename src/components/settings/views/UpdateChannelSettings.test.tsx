import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const initializeMock = mock(async () => undefined);
const checkForUpdatesMock = mock(async () => 'upToDate' as const);
const openDetailsMock = mock(() => undefined);
const resetMock = mock(async () => undefined);
const loadUpdateChannelMock = mock(async (): Promise<'stable' | 'preview'> => 'preview');
const saveUpdateChannelMock = mock(async (_channel?: 'stable' | 'preview') => undefined);
const notifyErrorMock = mock(() => undefined);
const notifyActionRequiredMock = mock((
  ..._args: [string, { actions?: Array<{ onClick?: () => void | Promise<void> }> }]
) => undefined);

let updateState: Record<string, unknown>;

const useAppUpdateStoreMock = Object.assign(
  (selector: (state: Record<string, unknown>) => unknown) => selector(updateState),
  { getState: () => updateState },
);

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallbackOrOptions?: string | Record<string, unknown>,
      maybeOptions?: Record<string, unknown>,
    ) => {
      const fallback = typeof fallbackOrOptions === 'string'
        ? fallbackOrOptions
        : String(fallbackOrOptions?.defaultValue ?? key);
      const values = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions;
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
        fallback,
      );
    },
  }),
}));

mock.module('../../../services/appUpdater', () => ({
  isAutomaticUpdaterEnabled: () => false,
}));

mock.module('../../../services/updateChannels', () => ({
  loadUpdateChannel: loadUpdateChannelMock,
  saveUpdateChannel: saveUpdateChannelMock,
}));

mock.module('../../../stores/useAppUpdateStore', () => ({
  useAppUpdateStore: useAppUpdateStoreMock,
}));

mock.module('../../ui/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

mock.module('../../ui/ConfirmPromptModal', () => ({
  ConfirmPromptModal: ({
    isOpen,
    title,
    confirmLabel,
    onConfirm,
  }: {
    isOpen: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) => isOpen ? (
    <div role="dialog">
      <p>{title}</p>
      <button type="button" onClick={onConfirm}>{confirmLabel}</button>
    </div>
  ) : null,
}));

mock.module('../../ui/toastService', () => ({
  notify: { error: notifyErrorMock, actionRequired: notifyActionRequiredMock },
}));

const { UpdateChannelSettings } = await import('./UpdateChannelSettings');

describe('UpdateChannelSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    updateState = {
      phase: 'ready',
      currentVersion: '0.1.1',
      availableUpdate: { version: '0.1.2-nightly.20260828.6' },
      downloadedBytes: 0,
      totalBytes: 0,
      checkInProgress: false,
      error: null,
      initialize: initializeMock,
      checkForUpdates: checkForUpdatesMock,
      openDetails: openDetailsMock,
      reset: resetMock,
    };
    initializeMock.mockClear();
    checkForUpdatesMock.mockClear();
    openDetailsMock.mockClear();
    resetMock.mockClear();
    loadUpdateChannelMock.mockClear();
    saveUpdateChannelMock.mockClear();
    notifyErrorMock.mockClear();
    notifyActionRequiredMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const renderSettings = async (strictMode = false) => {
    await act(async () => {
      root.render(strictMode ? <StrictMode><UpdateChannelSettings /></StrictMode> : <UpdateChannelSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === text,
    );

  it('presents update channels as a compact segmented control', async () => {
    await renderSettings();

    const legend = container.querySelector('legend');
    const choices = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(legend?.className).toContain('text-sm');
    expect(legend?.className).toContain('text-foreground');
    expect(choices).toHaveLength(2);
    expect(choices[0]?.textContent).toContain('Stable');
    expect(choices[1]?.textContent).toContain('Preview');
    expect(choices[1]?.getAttribute('aria-checked')).toBe('true');
    expect(choices[1]?.getAttribute('aria-label')).toContain('nightly and release candidate builds');
    expect(choices[0]?.getAttribute('aria-label')).toContain('production releases only');
    expect(container.querySelector('[data-icon="shield"]')).toBeNull();
    expect(container.querySelector('[data-icon="sparkles"]')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });

  it('keeps only the ready update and its actions below the channel control', async () => {
    await renderSettings();

    expect(container.textContent).not.toContain('Current version');
    expect(container.textContent).not.toContain('Macro v0.1.1');
    expect(container.textContent).toContain('Macro v0.1.2-nightly.20260828.6 is ready');
    expect(container.querySelector('[data-icon="check-circle"]')).toBeNull();
    expect(buttonByText('Install now')).toBeDefined();
    expect(buttonByText('Check for updates')?.disabled).toBe(true);

    await act(async () => buttonByText('Install now')?.click());
    expect(openDetailsMock).toHaveBeenCalledTimes(1);
  });

  it('confirms a switch from Preview to Stable before saving it', async () => {
    await renderSettings();

    const stableChoice = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((button) => button.textContent?.includes('Stable'));
    await act(async () => stableChoice?.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(saveUpdateChannelMock).not.toHaveBeenCalled();

    await act(async () => {
      buttonByText('Switch to Stable')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveUpdateChannelMock).toHaveBeenCalledWith('stable');
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it('supports arrow-key navigation between channel choices', async () => {
    loadUpdateChannelMock.mockImplementationOnce(async () => 'stable');
    await renderSettings();

    const stableChoice = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((button) => button.textContent?.includes('Stable'));
    await act(async () => {
      stableChoice?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveUpdateChannelMock).toHaveBeenCalledWith('preview');
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the saved channel visible and retries the updater refresh when reset fails', async () => {
    loadUpdateChannelMock.mockImplementation(async () => 'stable');
    resetMock.mockImplementationOnce(async () => {
      throw new Error('cache reset denied');
    });
    await renderSettings(true);

    const previewChoice = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((button) => button.textContent?.includes('Preview'));
    await act(async () => {
      previewChoice?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const choices = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(choices[0]?.getAttribute('aria-checked')).toBe('false');
    expect(choices[1]?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Update channel saved, but update information could not be refreshed.',
    );
    expect(buttonByText('Retry')).toBeDefined();
    expect(notifyActionRequiredMock).toHaveBeenCalledWith(
      'Update channel saved, but update information could not be refreshed.',
      expect.objectContaining({
        description: 'cache reset denied',
        notificationKey: 'update-channel-refresh',
        tone: 'warning',
        actions: [expect.objectContaining({ label: 'Retry', variant: 'primary' })],
      }),
    );

    const notificationAction = notifyActionRequiredMock.mock.calls[0]?.[1]
      ?.actions?.[0]?.onClick;
    expect(notificationAction).toBeInstanceOf(Function);

    await act(async () => {
      await notificationAction?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resetMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(choices[1]?.getAttribute('aria-checked')).toBe('true');
  });

  it('restores the previous channel when saving the preference fails', async () => {
    loadUpdateChannelMock.mockImplementationOnce(async () => 'stable');
    saveUpdateChannelMock.mockImplementationOnce(async () => {
      throw new Error('preference write denied');
    });
    await renderSettings();

    const previewChoice = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((button) => button.textContent?.includes('Preview'));
    await act(async () => {
      previewChoice?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const choices = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(choices[0]?.getAttribute('aria-checked')).toBe('true');
    expect(choices[1]?.getAttribute('aria-checked')).toBe('false');
    expect(resetMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).toHaveBeenCalledWith(
      'Could not save configuration',
      { description: 'preference write denied' },
    );
  });
});
