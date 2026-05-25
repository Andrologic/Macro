import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../../test-utils/reactI18nextMock';
import type { ComposerEditorHandle } from './ComposerEditor';

const translationMock = createTranslationMock({});

let removeComposerContextRef: ReturnType<typeof mock>;

const installStoreMock = () => {
  removeComposerContextRef = mock(() => undefined);
  const chatState = {
    composerContextRefs: [],
    removeComposerContextRef,
  };
  const useChatStore = ((selector?: (state: typeof chatState) => unknown) =>
    selector ? selector(chatState) : chatState) as typeof import('../../../stores/useChatStore').useChatStore;
  useChatStore.getState = () =>
    chatState as unknown as ReturnType<typeof useChatStore.getState>;

  mock.module('../../../stores/useChatStore', () => ({
    useChatStore,
  }));
};

describe('ComposerEditor context references', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ComposerEditor: typeof import('./ComposerEditor').ComposerEditor;

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
    installReactI18nextMock(translationMock);
    installStoreMock();

    ({ ComposerEditor } = await import(`./ComposerEditor.tsx?composer-editor-test=${Date.now()}`));
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

  it('round-trips bracketed skill text through a message-edit chip', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Edit message"
          onTextChange={() => undefined}
          onSend={() => undefined}
          surface="message-edit"
          syncContextRefs={false}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('[skill: test-skill] utilise ce skill');
      await Promise.resolve();
    });

    const skillChip = container.querySelector('[data-context-reference-kind="skill"]');
    expect(skillChip).toBeTruthy();
    expect(skillChip?.getAttribute('data-context-reference-surface')).toBe('message-edit');
    expect(skillChip?.textContent).toContain('Skill');
    expect(skillChip?.textContent).toContain('test-skill');
    expect(editorRef.current?.getTextContent()).toBe('[skill: test-skill] utilise ce skill');
  });

  it('does not remove composer context refs when deleting a message-edit chip', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Edit message"
          onTextChange={() => undefined}
          onSend={() => undefined}
          surface="message-edit"
          syncContextRefs={false}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('[skill: test-skill] utilise ce skill');
      await Promise.resolve();
    });

    const removeButton = container.querySelector('[data-context-reference-kind="skill"] button');
    expect(removeButton).toBeTruthy();

    await act(async () => {
      removeButton?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });

    expect(removeComposerContextRef).not.toHaveBeenCalled();
  });
});
