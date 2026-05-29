import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

interface TestComposerEditorHandle {
  clear: () => void;
  setText: (text: string) => void;
  getTextContent: () => string;
  focus: () => void;
}

interface MockComposerEditorProps {
  editable: boolean;
  placeholder: string;
  onTextChange: (text: string) => void;
  onSend: () => void;
}

let loadedEditorText = '';

const MockComposerEditor = React.forwardRef<TestComposerEditorHandle, MockComposerEditorProps>(
  (props, ref) => {
    React.useImperativeHandle(ref, () => ({
      clear: () => {
        loadedEditorText = '';
        props.onTextChange('');
      },
      setText: (text: string) => {
        loadedEditorText = text;
        props.onTextChange(text);
      },
      getTextContent: () => loadedEditorText,
      focus: () => undefined,
    }), [props]);

    return (
      <div
        data-shortcut-chat-input="true"
        data-testid="loaded-composer-editor"
        aria-disabled={props.editable ? 'false' : 'true'}
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
});
