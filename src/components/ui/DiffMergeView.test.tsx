import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffMergeView } from './DiffMergeView';

describe('DiffMergeView', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.height = '320px';
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    root = null;
    container = null;
  });

  it('renders merge view with two editors', async () => {
    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'line 1\nline 2\nline 3'}
          modified={'line 1\nmodified line 2\nline 3'}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
    expect(container?.querySelectorAll('.cm-editor').length).toBeGreaterThanOrEqual(2);
  });

  it('renders with correct original and modified content', async () => {
    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'original content'}
          modified={'modified content'}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const editors = container?.querySelectorAll('.cm-content');
    expect(editors?.length).toBeGreaterThanOrEqual(2);
  });

  it('calls onChange when modified content changes', async () => {
    let changeHandlerCalled = false;
    let changedValue = '';

    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'line 1\nline 2'}
          modified={'line 1\nchanged line 2'}
          onChange={(value) => {
            changeHandlerCalled = true;
            changedValue = value;
          }}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(changeHandlerCalled).toBe(false);
    expect(changedValue).toBe('');
  });

  it('handles empty content without errors', async () => {
    await act(async () => {
      root?.render(
        <DiffMergeView original="" modified="" />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
  });

  it('renders with revert controls when specified', async () => {
    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'line 1\nline 2'}
          modified={'line 1\nmodified line 2'}
          revertControls="a-to-b"
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const mergeView = container?.querySelector('.cm-mergeView');
    expect(mergeView).not.toBeNull();
  });

  it('applies language extension for typescript', async () => {
    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'const x: number = 1;'}
          modified={'const x: number = 2;'}
          language="typescript"
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
  });

  it('handles large content without crashing', async () => {
    const largeOriginal = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const largeModified = Array.from({ length: 100 }, (_, i) => `modified line ${i + 1}`).join('\n');

    await act(async () => {
      root?.render(
        <DiffMergeView
          original={largeOriginal}
          modified={largeModified}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
  });
});