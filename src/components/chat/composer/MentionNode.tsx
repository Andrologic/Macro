import { referenceText } from "../../../services/chat/composerReferenceText";
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
import type { ContextRefKind, ContextReference } from '../../../types';
import { MentionChip } from './MentionChip.tsx';
import { MENTION_NODE_TYPE, type MentionSurface } from './mentionContract';

export type { MentionSurface } from './mentionContract';

export type SerializedMentionNode = Spread<
  {
    reference?: ContextReference;
    refId: string;
    kind: ContextRefKind;
    title: string;
    surface?: MentionSurface;
    syncContextRefs?: boolean;
  },
  SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<ReactNode> {
  __reference?: ContextReference;
  __refId: string;
  __kind: ContextRefKind;
  __title: string;
  __surface: MentionSurface;
  __syncContextRefs: boolean;

  static getType(): string {
    return MENTION_NODE_TYPE;
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(
      node.__kind,
      node.__refId,
      node.__title,
      node.__key,
      node.__surface,
      node.__syncContextRefs,
      node.__reference
    );
  }

  constructor(
    kind: ContextRefKind,
    refId: string,
    title: string,
    key?: NodeKey,
    surface: MentionSurface = 'composer',
    syncContextRefs = true,
    reference?: ContextReference
  ) {
    super(key);
    this.__reference = reference;
    this.__refId = refId;
    this.__kind = kind;
    this.__title = title;
    this.__surface = surface;
    this.__syncContextRefs = syncContextRefs;
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
    element.textContent = this.__title;
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
      serializedNode.title,
      {
        reference: serializedNode.reference,
        surface: serializedNode.surface ?? 'composer',
        syncContextRefs: serializedNode.syncContextRefs ?? true,
      }
    );
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: MENTION_NODE_TYPE,
      refId: this.__refId,
      ...(this.__reference ? { reference: this.__reference } : {}),
      kind: this.__kind,
      title: this.__title,
      surface: this.__surface,
      syncContextRefs: this.__syncContextRefs,
    };
  }

  // ---- Getters ----

  getReference(): ContextReference | undefined { return this.__reference; }

  getKind(): ContextRefKind {
    return this.__kind;
  }

  getRefId(): string {
    return this.__refId;
  }

  getTitle(): string {
    return this.__title;
  }

  getSurface(): MentionSurface {
    return this.__surface;
  }

  shouldSyncContextRefs(): boolean {
    return this.__syncContextRefs;
  }

  // ---- Behavior ----

  getTextContent(): string {
    return this.__reference ? referenceText(this.__kind, this.__refId, this.__title) : `[${this.__kind}: ${this.__title}]`;
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    // Keep arrow-key movement as a caret navigation around the inline chip.
    // A keyboard-selectable DecoratorNode becomes a NodeSelection, which hides the caret.
    return false;
  }

  // ---- React decoration ----

  decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return (
      <MentionChip
        nodeKey={this.__key}
        kind={this.__kind}
        refId={this.__refId}
        title={this.__title}
        surface={this.__surface}
        syncContextRefs={this.__syncContextRefs}
      />
    );
  }
}

export function $createMentionNode(
  kind: ContextRefKind,
  refId: string,
  title: string,
  options: {
    surface?: MentionSurface;
    syncContextRefs?: boolean;
    reference?: ContextReference;
  } = {}
): MentionNode {
  return $applyNodeReplacement(
    new MentionNode(
      kind,
      refId,
      title,
      undefined,
      options.surface ?? 'composer',
      options.syncContextRefs ?? true,
      options.reference
    )
  );
}

export function $isMentionNode(
  node: LexicalNode | null | undefined
): node is MentionNode {
  return node instanceof MentionNode;
}
