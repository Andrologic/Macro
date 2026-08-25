import type {
  DOMExportOutput,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
} from 'lexical';
import { $applyNodeReplacement, DecoratorNode } from 'lexical';

export class GoalCommandNode extends DecoratorNode<null> {
  static getType(): string {
    return 'goal-command';
  }

  static clone(node: GoalCommandNode): GoalCommandNode {
    return new GoalCommandNode(node.__key);
  }

  static importJSON(_serializedNode: SerializedLexicalNode): GoalCommandNode {
    return $createGoalCommandNode();
  }

  constructor(key?: NodeKey) {
    super(key);
  }

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
    element.setAttribute('data-goal-command', 'true');
    element.textContent = '/goal';
    return { element };
  }

  exportJSON(): SerializedLexicalNode {
    return {
      ...super.exportJSON(),
      type: 'goal-command',
      version: 1,
    };
  }

  getTextContent(): string {
    return '/goal';
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return false;
  }

  decorate(): null {
    return null;
  }
}

export const $createGoalCommandNode = (): GoalCommandNode =>
  $applyNodeReplacement(new GoalCommandNode());

export const $isGoalCommandNode = (
  node: LexicalNode | null | undefined,
): node is GoalCommandNode => node instanceof GoalCommandNode;
