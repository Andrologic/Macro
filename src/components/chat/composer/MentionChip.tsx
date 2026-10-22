import { useTranslation } from "react-i18next";
import React from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey } from 'lexical';
import type { ContextRefKind } from '../../../types';
import { Icon } from '../../ui/Icon';
import { MENTION_NODE_TYPE, type MentionSurface } from './mentionContract';
import { ContextReferenceChip } from '../ContextReferenceChip';

interface MentionChipProps {
  nodeKey: string;
  kind: ContextRefKind;
  refId: string;
  title: string;
  surface?: MentionSurface;
  syncContextRefs?: boolean;
}

export const MentionChip: React.FC<MentionChipProps> = ({
  nodeKey,
  kind,
  title,
  surface = 'composer',
}) => {
  const [editor] = useLexicalComposerContext();
  const { t } = useTranslation();
  const handleRemove = (e: React.MouseEvent) => {
    if (!editor.isEditable()) return;
    e.preventDefault();
    e.stopPropagation();
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node?.getType() === MENTION_NODE_TYPE) {
        node.remove();
      }
    });
  };

  const removeButton = (
    <button
      type="button"
      aria-label={t("chat.contextToolbox.removeFromContext", "Remove from context")}
      title={t("chat.contextToolbox.removeFromContext", "Remove from context")}
      onMouseDown={handleRemove}
      onClick={(event) => { if (event.detail === 0) handleRemove(event); }}
      className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm opacity-50 transition-opacity hover:bg-primary/15 hover:opacity-100"
      tabIndex={0}
    >
      <Icon name="x" size={10} />
    </button>
  );

  return (
    <ContextReferenceChip
      kind={kind}
      title={title}
      surface={surface}
      renderAction={removeButton}
    />
  );
};
