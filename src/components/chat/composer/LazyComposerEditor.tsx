import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react';
import { cn } from '../../../utils/cn';
import { isPrimaryComposerSubmitKey } from './composerSubmitKey';
import type { ComposerEditorHandle } from './ComposerEditor';
import type { MentionSurface } from './MentionNode';
import { prepareContextualTextInsertion } from './composerTextInsertion';

interface LazyComposerEditorProps {
  editable: boolean;
  readOnly?: boolean;
  placeholder: string;
  onTextChange: (text: string) => void;
  onSend: () => void;
  onPromptHistory?: (direction: 'up' | 'down') => void;
  className?: string;
  initialText?: string;
  surface?: MentionSurface;
  syncContextRefs?: boolean;
}

type ComposerEditorComponent = ForwardRefExoticComponent<
  LazyComposerEditorProps & RefAttributes<ComposerEditorHandle>
>;

const syncComposerText = (
  editorRef: React.RefObject<ComposerEditorHandle | null>,
  text: string
) => {
  if (!editorRef.current) {
    return false;
  }

  editorRef.current.setText(text);
  return true;
};

export const LazyComposerEditor = forwardRef<ComposerEditorHandle, LazyComposerEditorProps>(
  ({
    editable,
    readOnly = false,
    placeholder,
    onTextChange,
    onSend,
    onPromptHistory,
    className,
    initialText = '',
    surface = 'composer',
    syncContextRefs = true,
  }, ref) => {
    const [LoadedEditor, setLoadedEditor] = useState<ComposerEditorComponent | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const loadedEditorRef = useRef<ComposerEditorHandle>(null);
    const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);
    const fallbackTextRef = useRef(initialText);
    const lastInitialTextRef = useRef(initialText);

    useEffect(() => {
      let isMounted = true;

      void import('./ComposerEditor').then((module) => {
        if (!isMounted) {
          return;
        }
        setLoadedEditor(() => module.ComposerEditor as ComposerEditorComponent);
      }).catch((error: unknown) => {
        if (!isMounted) {
          return;
        }
        setLoadFailed(true);
        console.error(
          '[LazyComposerEditor] Failed to load the rich composer; keeping the textarea fallback.',
          error,
        );
      });

      return () => {
        isMounted = false;
      };
    }, []);

    useEffect(() => {
      if (!LoadedEditor || fallbackTextRef.current.length === 0) {
        return;
      }

      const syncOnNextFrame = () => {
        syncComposerText(loadedEditorRef, fallbackTextRef.current);
      };

      const frameId = window.requestAnimationFrame(syncOnNextFrame);
      return () => {
        window.cancelAnimationFrame(frameId);
      };
    }, [LoadedEditor]);

    useEffect(() => {
      if (initialText === lastInitialTextRef.current) {
        return;
      }

      lastInitialTextRef.current = initialText;
      fallbackTextRef.current = initialText;

      if (loadedEditorRef.current) {
        loadedEditorRef.current.setText(initialText);
        return;
      }

      if (fallbackTextareaRef.current) {
        fallbackTextareaRef.current.value = initialText;
      }

      onTextChange(initialText);
    }, [initialText, onTextChange]);

    useImperativeHandle(ref, () => ({
      clear: () => {
        fallbackTextRef.current = '';

        if (loadedEditorRef.current) {
          loadedEditorRef.current.clear();
          return;
        }

        if (fallbackTextareaRef.current) {
          fallbackTextareaRef.current.value = '';
        }
        onTextChange('');
      },
      setText: (text: string) => {
        fallbackTextRef.current = text;

        if (loadedEditorRef.current) {
          loadedEditorRef.current.setText(text);
          return;
        }

        if (fallbackTextareaRef.current) {
          fallbackTextareaRef.current.value = text;
        }
        onTextChange(text);
      },
      insertTextAtSelection: (text: string, spacing = 'preserve') => {
        if (loadedEditorRef.current) {
          return loadedEditorRef.current.insertTextAtSelection(text, spacing);
        }
        const textarea = fallbackTextareaRef.current;
        if (!textarea) return fallbackTextRef.current;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? start;
        const insertion = spacing === 'contextual'
          ? prepareContextualTextInsertion({
              text,
              before: textarea.value.slice(0, start),
              after: textarea.value.slice(end),
            })
          : text;
        textarea.setRangeText(insertion, start, end, 'end');
        fallbackTextRef.current = textarea.value;
        onTextChange(textarea.value);
        textarea.focus();
        return textarea.value;
      },
      getTextContent: () => {
        if (loadedEditorRef.current) {
          return loadedEditorRef.current.getTextContent();
        }

        return fallbackTextareaRef.current?.value ?? fallbackTextRef.current;
      },
      focus: () => {
        if (loadedEditorRef.current) {
          loadedEditorRef.current.focus();
          return;
        }

        fallbackTextareaRef.current?.focus();
      },
    }), [onTextChange]);

    if (LoadedEditor && !loadFailed) {
      return (
        <LoadedEditor
          ref={loadedEditorRef}
          editable={editable}
          readOnly={readOnly}
          placeholder={placeholder}
          onTextChange={onTextChange}
          onSend={onSend}
          onPromptHistory={onPromptHistory}
          className={className}
          surface={surface}
          syncContextRefs={syncContextRefs}
        />
      );
    }

    return (
      <div className="relative flex-1">
        <textarea
          ref={fallbackTextareaRef}
          data-shortcut-chat-input="true"
          defaultValue={fallbackTextRef.current}
          disabled={!editable}
          readOnly={readOnly}
          aria-readonly={readOnly || undefined}
          placeholder={placeholder}
          onChange={(event) => {
            fallbackTextRef.current = event.target.value;
            onTextChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              isPrimaryComposerSubmitKey(event)
            ) {
              event.preventDefault();
              onSend();
              return;
            }

            if (!onPromptHistory) {
              return;
            }

            const target = event.currentTarget;
            const selectionStart = target.selectionStart ?? 0;
            const selectionEnd = target.selectionEnd ?? 0;
            const textLength = target.value.length;

            if (event.key === 'ArrowUp' && selectionStart === 0 && selectionEnd === 0) {
              event.preventDefault();
              onPromptHistory('up');
            }

            if (event.key === 'ArrowDown' && selectionStart === textLength && selectionEnd === textLength) {
              event.preventDefault();
              onPromptHistory('down');
            }
          }}
          className={cn(
            'flex-1 min-w-[100px] w-full resize-none bg-transparent border-0 outline-none text-sm text-foreground',
            'min-h-[32px] max-h-[120px] overflow-y-auto px-1 py-[6.5px] leading-[1.35]',
            !editable && 'opacity-50 cursor-not-allowed',
            className
          )}
        />
      </div>
    );
  }
);

LazyComposerEditor.displayName = 'LazyComposerEditor';

export type { ComposerEditorHandle };
export default LazyComposerEditor;
