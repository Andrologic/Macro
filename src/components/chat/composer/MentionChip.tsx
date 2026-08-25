import React from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey } from 'lexical';
import type { ContextRefKind } from '../../../types';
import { useChatStore } from '../../../stores/useChatStore';
import { Icon } from '../../ui/Icon';
import { $isMentionNode, type MentionSurface } from './MentionNode';
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
  refId,
  title,
  surface = 'composer',
  syncContextRefs = true,
}) => {
  const [editor] = useLexicalComposerContext();
  const handleRemove = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isMentionNode(node)) {
        node.remove();
      }
    });
    if (syncContextRefs) {
      useChatStore.getState().removeComposerContextRef(refId, kind);
    }
  };

  const removeButton = (
    <button
      type="button"
      onMouseDown={handleRemove}
      className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm opacity-50 transition-opacity hover:bg-primary/15 hover:opacity-100"
      tabIndex={-1}
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
