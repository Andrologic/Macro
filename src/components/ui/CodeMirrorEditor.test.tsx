import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import CodeMirrorEditor from './CodeMirrorEditor';

describe('CodeMirrorEditor diff highlights', () => {
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

  it('renders line and gutter classes for provided highlights', async () => {
    await act(async () => {
      root?.render(
        <CodeMirrorEditor
          code={'line 1\nline 2\nline 3'}
          lineHighlights={[
            {
              lineNumber: 2,
              lineClass: 'cm-diff-added',
              gutterClass: 'cm-diff-gutter-added',
            },
          ]}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const lineEl = container?.querySelector('.cm-line.cm-diff-added');
    expect(lineEl).not.toBeNull();

    const gutterEl = container?.querySelector('.cm-gutterElement.cm-diff-gutter-added');
    expect(gutterEl).not.toBeNull();
  });

  it('renders multiple different highlight types correctly', async () => {
    await act(async () => {
      root?.render(
        <CodeMirrorEditor
          code={'line 1\nline 2\nline 3\nline 4\nline 5'}
          lineHighlights={[
            { lineNumber: 1, lineClass: 'cm-diff-removed', gutterClass: 'cm-diff-gutter-removed' },
            { lineNumber: 3, lineClass: 'cm-diff-added', gutterClass: 'cm-diff-gutter-added' },
            { lineNumber: 5, lineClass: 'cm-diff-modified-right', gutterClass: 'cm-diff-gutter-modified-right' },
          ]}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('.cm-line.cm-diff-removed')).not.toBeNull();
    expect(container?.querySelector('.cm-gutterElement.cm-diff-gutter-removed')).not.toBeNull();
    expect(container?.querySelector('.cm-line.cm-diff-added')).not.toBeNull();
    expect(container?.querySelector('.cm-gutterElement.cm-diff-gutter-added')).not.toBeNull();
    expect(container?.querySelector('.cm-line.cm-diff-modified-right')).not.toBeNull();
    expect(container?.querySelector('.cm-gutterElement.cm-diff-gutter-modified-right')).not.toBeNull();
  });

  it('line highlights are preserved after code content update', async () => {
    await act(async () => {
      root?.render(
        <CodeMirrorEditor
          code={'line 1\nline 2\nline 3'}
          lineHighlights={[
            { lineNumber: 2, lineClass: 'cm-diff-added', gutterClass: 'cm-diff-gutter-added' },
          ]}
          onChange={() => {}}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('.cm-line.cm-diff-added')).not.toBeNull();
    expect(container?.querySelector('.cm-gutterElement.cm-diff-gutter-added')).not.toBeNull();
  });

  it('handles empty highlights array without errors', async () => {
    await act(async () => {
      root?.render(
        <CodeMirrorEditor
          code={'line 1\nline 2\nline 3'}
          lineHighlights={[]}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('.cm-editor')).not.toBeNull();
    expect(container?.querySelectorAll('.cm-diff-added').length).toBe(0);
  });
});
