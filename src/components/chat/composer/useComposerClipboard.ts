import { useEffect } from 'react';
import { $getClipboardDataFromSelection, $insertDataTransferForRichText } from '@lexical/clipboard';
import {
  $getSelection, $isRangeSelection, COPY_COMMAND, CUT_COMMAND,
  PASTE_COMMAND, PASTE_TAG, COMMAND_PRIORITY_HIGH, type LexicalEditor,
} from 'lexical';
import { COMPOSER_REFERENCE_PATTERN } from '../../../services/chat/composerReferenceText';

/** Rich references inside Macro; readable text for external applications. */
export function useComposerClipboard(editor: LexicalEditor) {
    useEffect(() => {
      const copy = (event: ClipboardEvent | KeyboardEvent | null, cut: boolean) => {
        if ((cut && !editor.isEditable()) || !event || !('clipboardData' in event) || !event.clipboardData) return false;
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
        const data = $getClipboardDataFromSelection(selection);
        event.preventDefault();
        for (const [type, value] of Object.entries(data)) {
          if (value !== undefined) event.clipboardData.setData(type,
            type === 'text/plain'
              ? value.replace(new RegExp(COMPOSER_REFERENCE_PATTERN), (_full, _kind, title) => title)
              : value);
        }
        if (cut) selection.removeText();
        return true;
      };
      const removeCopy = editor.registerCommand(COPY_COMMAND, event => copy(event, false), COMMAND_PRIORITY_HIGH);
      const removeCut = editor.registerCommand(CUT_COMMAND, event => copy(event, true), COMMAND_PRIORITY_HIGH);
      return () => { removeCopy(); removeCut(); };
    }, [editor]);

    // Keep Macro's structured references on internal paste. Other applications
    // continue through PlainTextPlugin and cannot create attached context.
    useEffect(() => editor.registerCommand(PASTE_COMMAND, event => {
      if (!('clipboardData' in event) || !event.clipboardData) return false;
      const data = event.clipboardData;
      const serialized = data.getData('application/x-lexical-editor');
      if (!serialized) return false;
      try {
        if (JSON.parse(serialized).namespace !== 'MacroComposer') return false;
      } catch { return false; }
      if (!$isRangeSelection($getSelection())) return false;
      event.preventDefault();
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          $insertDataTransferForRichText(data, selection, editor);
        }
      }, { tag: PASTE_TAG });
      return true;
    }, COMMAND_PRIORITY_HIGH), [editor]);

}
