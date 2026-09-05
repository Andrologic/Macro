import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ContextReference } from '../../../types';

interface TestComposerEditorHandle {
  clear: () => void;
  setText: (text: string, contextRefs?: readonly ContextReference[]) => void;
  insertTextAtSelection: (text: string, spacing?: 'preserve' | 'contextual') => string;
  getTextContent: () => string;
  focus: () => void;
}

interface MockComposerEditorProps {
  editable: boolean;
  readOnly?: boolean;
  placeholder: string;
  accessibleName?: string;
  onTextChange: (text: string) => void;
  onSend: () => void;
}

let loadedEditorText = '';
let loadedEditorContextRefs: readonly ContextReference[] = [];

const MockComposerEditor = React.forwardRef<TestComposerEditorHandle, MockComposerEditorProps>(
  (props, ref) => {
    React.useImperativeHandle(ref, () => ({
      clear: () => {
        loadedEditorText = '';
        props.onTextChange('');
      },
      setText: (text: string, contextRefs = []) => {
        loadedEditorText = text;
        loadedEditorContextRefs = contextRefs;
        props.onTextChange(text);
      },
      insertTextAtSelection: (text: string) => {
        loadedEditorText += text;
        props.onTextChange(loadedEditorText);
        return loadedEditorText;
      },
      getTextContent: () => loadedEditorText,
      focus: () => undefined,
    }), [props]);

    return (
      <div
        data-shortcut-chat-input="true"
        data-testid="loaded-composer-editor"
        aria-disabled={props.editable ? 'false' : 'true'}
        aria-readonly={props.readOnly ? 'true' : 'false'}
        aria-label={props.accessibleName ?? props.placeholder}
      >
        {loadedEditorText || props.placeholder}
      </div>
    );
  }
);
MockComposerEditor.displayName = 'MockComposerEditor';

describe('LazyComposerEditor', () => {
  let container: HTMLDivElement;
  let root: Root;
  let LazyComposerEditor: typeof import('./LazyComposerEditor').LazyComposerEditor;

  const waitForLoadedEditor = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (container.querySelector('[data-testid="loaded-composer-editor"]')) {
        return;
      }

      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    if (!globalThis.requestAnimationFrame) {
      globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 0) as unknown as number;
    }
    if (!globalThis.cancelAnimationFrame) {
      globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
    }

    mock.restore();
    loadedEditorText = '';
    loadedEditorContextRefs = [];
    mock.module('./ComposerEditor', () => ({
      __esModule: true,
      ComposerEditor: MockComposerEditor,
    }));

    ({ LazyComposerEditor } = await import(`./LazyComposerEditor.tsx?lazy-composer-test=${Date.now()}`));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    mock.restore();
  });

  it('keeps the textarea fallback when the rich editor import fails', async () => {
    const importError = new Error('composer chunk unavailable');
    mock.module('./ComposerEditor', () => Promise.reject(importError));
    const failedModule = await import(
      `./LazyComposerEditor.tsx?lazy-composer-load-failure=${Date.now()}`
    );
    const onTextChange = mock((_text: string) => undefined);
    const errorSpy = mock(() => undefined);
    const originalError = console.error;
    console.error = errorSpy as never;

    try {
      await act(async () => {
        flushSync(() => {
          root.render(
            <failedModule.LazyComposerEditor
              editable
              placeholder="Message"
              onTextChange={onTextChange}
              onSend={() => undefined}
            />
          );
        });
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.querySelector('textarea')).not.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load the rich composer'),
        importError,
      );
    } finally {
      console.error = originalError;
    }
  });

  it('emits one text change for fallback setText and clear calls', async () => {
    const onTextChange = mock((_text: string) => undefined);
    const editorRef = React.createRef<TestComposerEditorHandle>();

    await act(async () => {
      flushSync(() => {
        root.render(
          <LazyComposerEditor
            ref={editorRef}
            editable
            placeholder="Message"
            onTextChange={onTextChange}
            onSend={() => undefined}
          />
        );
      });

      editorRef.current?.setText('fallback draft');
      editorRef.current?.clear();
    });

    expect(onTextChange.mock.calls.map((call) => call[0])).toEqual([
      'fallback draft',
      '',
    ]);
  });

  it('inserts dictated text at the fallback textarea selection', async () => {
    const onTextChange = mock((_text: string) => undefined);
    const editorRef = React.createRef<TestComposerEditorHandle>();

    await act(async () => {
      flushSync(() => {
        root.render(
          <LazyComposerEditor
            ref={editorRef}
            editable
            placeholder="Message"
            onTextChange={onTextChange}
            onSend={() => undefined}
            initialText="Bonjour monde"
          />
        );
      });
      const textarea = container.querySelector('textarea');
      expect(textarea).not.toBeNull();
      textarea?.setSelectionRange(8, 13);
      const insertedText = editorRef.current?.insertTextAtSelection('Macro');
      expect(insertedText).toBe('Bonjour Macro');
    });

    expect(onTextChange).toHaveBeenLastCalledWith('Bonjour Macro');
    expect(editorRef.current?.getTextContent()).toBe('Bonjour Macro');
  });

  it('keeps cleanup text read-only and scrollable in both editor implementations', async () => {
    await act(async () => {
      flushSync(() => {
        root.render(
          <LazyComposerEditor
            editable
            readOnly
            placeholder="Message"
            onTextChange={() => undefined}
            onSend={() => undefined}
          />
        );
      });

      const fallback = container.querySelector('textarea');
      expect(fallback?.disabled).toBe(false);
      expect(fallback?.readOnly).toBe(true);
      expect(fallback?.getAttribute('aria-readonly')).toBe('true');
    });

    await waitForLoadedEditor();

    const loadedEditor = container.querySelector('[data-testid="loaded-composer-editor"]');
    expect(loadedEditor?.getAttribute('aria-disabled')).toBe('false');
    expect(loadedEditor?.getAttribute('aria-readonly')).toBe('true');
  });

  it('spaces dictated text according to the fallback textarea selection', async () => {
    const onTextChange = mock((_text: string) => undefined);
    const editorRef = React.createRef<TestComposerEditorHandle>();

    await act(async () => {
      flushSync(() => {
        root.render(
          <LazyComposerEditor
            ref={editorRef}
            editable
            placeholder="Message"
            onTextChange={onTextChange}
            onSend={() => undefined}
            initialText="Bonjourmonde"
          />
        );
      });
      const textarea = container.querySelector('textarea');
      textarea?.setSelectionRange(7, 7);
      const insertedText = editorRef.current?.insertTextAtSelection('Macro', 'contextual');
      expect(insertedText).toBe('Bonjour Macro monde');
    });

    expect(onTextChange).toHaveBeenLastCalledWith('Bonjour Macro monde');
  });

  it('delegates loaded setText and clear calls without emitting locally first', async () => {
    const onTextChange = mock((_text: string) => undefined);
    const editorRef = React.createRef<TestComposerEditorHandle>();

    await act(async () => {
      root.render(
        <LazyComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={onTextChange}
          onSend={() => undefined}
        />
      );
    });
    await waitForLoadedEditor();

    expect(container.querySelector('[data-testid="loaded-composer-editor"]')).not.toBeNull();
    onTextChange.mockClear();

    await act(async () => {
      editorRef.current?.setText('loaded draft');
      await Promise.resolve();
    });

    expect(onTextChange.mock.calls.map((call) => call[0])).toEqual(['loaded draft']);

    onTextChange.mockClear();

    await act(async () => {
      editorRef.current?.clear();
      await Promise.resolve();
    });

    expect(onTextChange.mock.calls.map((call) => call[0])).toEqual(['']);
  });

  it('delegates changed initialText through the loaded editor once', async () => {
    const onTextChange = mock((_text: string) => undefined);
    const editorRef = React.createRef<TestComposerEditorHandle>();

    await act(async () => {
      root.render(
        <LazyComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={onTextChange}
          onSend={() => undefined}
          initialText=""
        />
      );
    });
    await waitForLoadedEditor();

    onTextChange.mockClear();

    await act(async () => {
      root.render(
        <LazyComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={onTextChange}
          onSend={() => undefined}
          initialText="loaded initial"
        />
      );
      await Promise.resolve();
    });

    expect(onTextChange.mock.calls.map((call) => call[0])).toEqual(['loaded initial']);
  });

  it('keeps context references while the rich editor loads', async () => {
    const editorRef = React.createRef<TestComposerEditorHandle>();
    const contextRefs = [{
      id: 'src/App.tsx',
      kind: 'file',
      title: 'App.tsx',
      data: {
        id: 'src/App.tsx',
        path: 'src/App.tsx',
        relativePath: 'src/App.tsx',
      },
    }] satisfies ContextReference[];

    await act(async () => {
      flushSync(() => {
        root.render(
          <LazyComposerEditor
            ref={editorRef}
            editable
            accessibleName="Message composer"
            placeholder="Message"
            onTextChange={() => undefined}
            onSend={() => undefined}
          />
        );
      });
      editorRef.current?.setText('[file: App.tsx]', contextRefs);
    });
    await waitForLoadedEditor();

    expect(loadedEditorText).toBe('[file: App.tsx]');
    expect(loadedEditorContextRefs).toEqual(contextRefs);
    expect(
      container.querySelector('[data-testid="loaded-composer-editor"]')?.getAttribute('aria-label'),
    ).toBe('Message composer');
  });

});
