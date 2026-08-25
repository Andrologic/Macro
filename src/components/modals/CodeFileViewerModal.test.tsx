import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCodeFileStore } from '../../stores/useCodeFileStore';

describe('CodeFileViewerModal', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let originalClipboard: PropertyDescriptor | undefined;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    root = null;
    container = null;
    useCodeFileStore.getState().closeFileViewer();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    }
    document.body.innerHTML = '';
    mock.restore();
  });

  it('opens empty files and resets copy feedback when reopened', async () => {
    const writeText = mock(async () => undefined);
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mock.module('react-i18next', () => ({
      useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
    }));
    mock.module('../ui/CodeViewer', () => ({
      CodeViewer: ({ code }: { code: string }) => <pre>{code}</pre>,
    }));
    const { CodeFileViewerModal } = await import(`./CodeFileViewerModal.tsx?copy-test=${Date.now()}`);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useCodeFileStore.getState().openFileViewer('empty.ts', '', 'typescript');
    await act(async () => {
      root?.render(<CodeFileViewerModal />);
      await Promise.resolve();
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    const copyButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Copy code'
    );
    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('');
    expect(document.body.textContent).toContain('Copied');

    await act(async () => {
      useCodeFileStore.getState().closeFileViewer();
      await Promise.resolve();
      useCodeFileStore.getState().openFileViewer('empty.ts', '', 'typescript');
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Copy code');
    expect(document.body.textContent).not.toContain('Copied');
  });
});
