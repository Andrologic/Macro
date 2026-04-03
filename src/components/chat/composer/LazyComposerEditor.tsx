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
import type { ComposerEditorHandle } from './ComposerEditor';

interface LazyComposerEditorProps {
  editable: boolean;
  placeholder: string;
  onTextChange: (text: string) => void;
  onSend: () => void;
  onPromptHistory?: (direction: 'up' | 'down') => void;
  className?: string;
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
  ({ editable, placeholder, onTextChange, onSend, onPromptHistory, className }, ref) => {
    const [LoadedEditor, setLoadedEditor] = useState<ComposerEditorComponent | null>(null);
    const loadedEditorRef = useRef<ComposerEditorHandle>(null);
    const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);
    const fallbackTextRef = useRef('');

    useEffect(() => {
      let isMounted = true;

      void import('./ComposerEditor').then((module) => {
        if (!isMounted) {
          return;
        }
        setLoadedEditor(() => module.ComposerEditor as ComposerEditorComponent);
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

    useImperativeHandle(ref, () => ({
      clear: () => {
        fallbackTextRef.current = '';
        onTextChange('');

        if (loadedEditorRef.current) {
          loadedEditorRef.current.clear();
          return;
        }

        if (fallbackTextareaRef.current) {
          fallbackTextareaRef.current.value = '';
        }
      },
      setText: (text: string) => {
        fallbackTextRef.current = text;
        onTextChange(text);

        if (loadedEditorRef.current) {
          loadedEditorRef.current.setText(text);
          return;
        }

        if (fallbackTextareaRef.current) {
          fallbackTextareaRef.current.value = text;
        }
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

    if (LoadedEditor) {
      return (
        <LoadedEditor
          ref={loadedEditorRef}
          editable={editable}
          placeholder={placeholder}
          onTextChange={onTextChange}
          onSend={onSend}
          onPromptHistory={onPromptHistory}
          className={className}
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
          placeholder={placeholder}
          onChange={(event) => {
            fallbackTextRef.current = event.target.value;
            onTextChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
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
            'min-h-[32px] max-h-[120px] overflow-y-auto py-1 px-1',
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
