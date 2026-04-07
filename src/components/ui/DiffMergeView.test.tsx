import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffMergeView, type MergeViewEditorHandle } from './DiffMergeView';

describe('DiffMergeView', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const flushRender = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    container = document.createElement('div');
    container.style.height = '320px';
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    root = null;
    container = null;
  });

  const requireHandle = (handle: MergeViewEditorHandle | null): MergeViewEditorHandle => {
    expect(handle).not.toBeNull();
    return handle as MergeViewEditorHandle;
  };

  it('renders merge view with two editors', async () => {
    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'line 1\nline 2\nline 3'}
          modified={'line 1\nmodified line 2\nline 3'}
        />
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
    expect(container?.querySelectorAll('.cm-editor').length).toBeGreaterThanOrEqual(2);
  });

  it('renders diff highlights for changed lines and text', async () => {
    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'line 1\nline 2\nline 3'}
          modified={'line 1\nline 20\nline 3'}
        />
      );
      await flushRender();
    });

    expect(container?.querySelectorAll('.cm-changedLine').length).toBe(2);
    expect(container?.querySelectorAll('.cm-changedText').length).toBeGreaterThan(0);
  });

  it('does not emit onChange during mount or external prop synchronization', async () => {
    let onChangeCalls = 0;
    let latestHandle: MergeViewEditorHandle | null = null;

    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'before();'}
          modified={'after();'}
          onChange={() => {
            onChangeCalls += 1;
          }}
          onEditorReady={(handle) => {
            latestHandle = handle;
          }}
        />
      );
      await flushRender();
    });

    expect(onChangeCalls).toBe(0);
    expect(requireHandle(latestHandle).b.state.doc.toString()).toBe('after();');

    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'before();'}
          modified={'after();\nconsole.log("synced");'}
          onChange={() => {
            onChangeCalls += 1;
          }}
          onEditorReady={(handle) => {
            latestHandle = handle;
          }}
        />
      );
      await flushRender();
    });

    expect(onChangeCalls).toBe(0);
    expect(requireHandle(latestHandle).b.state.doc.toString()).toBe('after();\nconsole.log("synced");');
  });

  it('recalculates diff chunks when props change after mount', async () => {
    let latestHandle: MergeViewEditorHandle | null = null;

    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'line 1\nline 2'}
          modified={'line 1\nline 20'}
          onEditorReady={(handle) => {
            latestHandle = handle;
          }}
        />
      );
      await flushRender();
    });

    expect(container?.querySelectorAll('.cm-changedLine').length).toBe(2);
    expect(container?.querySelectorAll('.cm-changedText').length).toBeGreaterThan(0);

    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'line 1\nline 2'}
          modified={'line 1\nline 2'}
          onEditorReady={(handle) => {
            latestHandle = handle;
          }}
        />
      );
      await flushRender();
    });

    expect(container?.querySelectorAll('.cm-changedLine').length).toBe(0);
    expect(container?.querySelectorAll('.cm-changedText').length).toBe(0);
    expect(requireHandle(latestHandle).a.state.doc.toString()).toBe('line 1\nline 2');
    expect(requireHandle(latestHandle).b.state.doc.toString()).toBe('line 1\nline 2');

    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'alpha();'}
          modified={'beta();'}
          onEditorReady={(handle) => {
            latestHandle = handle;
          }}
        />
      );
      await flushRender();
    });

    expect(container?.querySelectorAll('.cm-changedLine').length).toBe(2);
    expect(requireHandle(latestHandle).a.state.doc.toString()).toBe('alpha();');
    expect(requireHandle(latestHandle).b.state.doc.toString()).toBe('beta();');
  });

  it('handles empty content without errors', async () => {
    await act(async () => {
      root?.render(<DiffMergeView original="" modified="" />);
      await flushRender();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
  });

  it('renders revert controls when specified', async () => {
    await act(async () => {
      root?.render(
        <DiffMergeView
          original={'line 1\nline 2'}
          modified={'line 1\nmodified line 2'}
          revertControls="a-to-b"
        />
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-merge-revert button')).not.toBeNull();
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
      await flushRender();
    });

    expect(container?.querySelector('[data-language="typescript"]')).not.toBeNull();
  });

  it('handles large content without crashing', async () => {
    const largeOriginal = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
    const largeModified = Array.from({ length: 100 }, (_, index) => `modified line ${index + 1}`).join('\n');

    await act(async () => {
      root?.render(
        <DiffMergeView
          original={largeOriginal}
          modified={largeModified}
        />
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
  });
});
