import type { ReactNode } from 'react';
import type {
  DOMConversionMap,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical';
import { $applyNodeReplacement, DecoratorNode } from 'lexical';
import type { ContextRefKind } from '../../../types';
import { MentionChip } from './MentionChip.tsx';

export type SerializedMentionNode = Spread<
  {
    refId: string;
    kind: ContextRefKind;
    title: string;
  },
  SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<ReactNode> {
  __refId: string;
  __kind: ContextRefKind;
  __title: string;

  static getType(): string {
    return 'mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__kind, node.__refId, node.__title, node.__key);
  }

  constructor(kind: ContextRefKind, refId: string, title: string, key?: NodeKey) {
    super(key);
    this.__refId = refId;
    this.__kind = kind;
    this.__title = title;
  }

  // ---- DOM ----

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'inline';
    return span;
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.setAttribute('data-lexical-mention', 'true');
    element.setAttribute('data-ref-kind', this.__kind);
    element.setAttribute('data-ref-id', this.__refId);
    element.textContent = `[${this.__kind}: ${this.__title}]`;
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  // ---- Serialization ----

  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    return $createMentionNode(
      serializedNode.kind,
      serializedNode.refId,
      serializedNode.title
    );
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: 'mention',
      refId: this.__refId,
      kind: this.__kind,
      title: this.__title,
    };
  }

  // ---- Getters ----

  getKind(): ContextRefKind {
    return this.__kind;
  }

  getRefId(): string {
    return this.__refId;
  }

  getTitle(): string {
    return this.__title;
  }

  // ---- Behavior ----

  getTextContent(): string {
    return `[${this.__kind}: ${this.__title}]`;
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  // ---- React decoration ----

  decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return (
      <MentionChip
        nodeKey={this.__key}
        kind={this.__kind}
        refId={this.__refId}
        title={this.__title}
      />
    );
  }
}

export function $createMentionNode(
  kind: ContextRefKind,
  refId: string,
  title: string
): MentionNode {
  return $applyNodeReplacement(new MentionNode(kind, refId, title));
}

export function $isMentionNode(
  node: LexicalNode | null | undefined
): node is MentionNode {
  return node instanceof MentionNode;
}
