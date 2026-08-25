import { describe, expect, it } from 'bun:test';
import {
  createEditor,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  TextNode,
} from 'lexical';
import {
  GoalCommandNode,
  $createGoalCommandNode,
  $isGoalCommandNode,
} from './GoalCommandNode';
import { transformGoalCommandTextNode } from './GoalCommandPlugin';

describe('GoalCommandNode', () => {
  it('keeps the textual Goal command in editor state and serialization', async () => {
    const editor = createEditor({
      namespace: `GoalCommandNodeTest-${Date.now()}`,
      nodes: [GoalCommandNode],
      onError: (error) => {
        throw error;
      },
    });

    await new Promise<void>((resolve) => {
      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          paragraph.append($createGoalCommandNode(), $createTextNode(' Finish the migration'));
          root.append(paragraph);
        },
        { onUpdate: resolve },
      );
    });

    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      '/goal Finish the migration',
    );
    const serialized = editor.getEditorState().toJSON();
    expect(JSON.stringify(serialized)).toContain('goal-command');
  });

  it('decorates a leading Goal command after its separator', async () => {
    const editor = createEditor({
      namespace: `GoalCommandTransformTest-${Date.now()}`,
      nodes: [GoalCommandNode],
      onError: (error) => {
        throw error;
      },
    });
    editor.registerNodeTransform(TextNode, transformGoalCommandTextNode);

    await new Promise<void>((resolve) => {
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          paragraph.append($createTextNode('/goal Finish the migration'));
          $getRoot().append(paragraph);
        },
        { onUpdate: resolve },
      );
    });

    editor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChild();
      const children = $isElementNode(paragraph) ? paragraph.getChildren() : [];
      expect($isGoalCommandNode(children[0])).toBe(true);
      expect($isTextNode(children[1])).toBe(true);
      expect($getRoot().getTextContent()).toBe('/goal Finish the migration');
    });
  });

  it('waits for whitespace and leaves Goal lookalikes untouched', async () => {
    const editor = createEditor({
      namespace: `GoalCommandBoundaryTest-${Date.now()}`,
      nodes: [GoalCommandNode],
      onError: (error) => {
        throw error;
      },
    });
    editor.registerNodeTransform(TextNode, transformGoalCommandTextNode);

    const writeText = (text: string) =>
      new Promise<void>((resolve) => {
        editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode(text));
            root.append(paragraph);
          },
          { onUpdate: resolve },
        );
      });

    await writeText('/goal');
    expect(
      editor.getEditorState().read(() =>
        (() => {
          const paragraph = $getRoot().getFirstChild();
          return $isElementNode(paragraph) && $isGoalCommandNode(paragraph.getFirstChild());
        })(),
      ),
    ).toBe(false);

    await new Promise<void>((resolve) => {
      editor.update(
        () => {
          const paragraph = $getRoot().getFirstChild();
          const commandText = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
          if ($isTextNode(commandText)) {
            commandText.setTextContent('/goals list');
          }
        },
        { onUpdate: resolve },
      );
    });
    expect(
      editor.getEditorState().read(() =>
        (() => {
          const paragraph = $getRoot().getFirstChild();
          return $isElementNode(paragraph) && $isGoalCommandNode(paragraph.getFirstChild());
        })(),
      ),
    ).toBe(false);

    await writeText('Explain /goal behavior');
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      'Explain /goal behavior',
    );
  });

  it('preserves leading whitespace while decorating a valid Goal command', async () => {
    const editor = createEditor({
      namespace: `GoalCommandWhitespaceTest-${Date.now()}`,
      nodes: [GoalCommandNode],
      onError: (error) => {
        throw error;
      },
    });
    editor.registerNodeTransform(TextNode, transformGoalCommandTextNode);

    await new Promise<void>((resolve) => {
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          paragraph.append($createTextNode('  /goal Finish the migration'));
          $getRoot().append(paragraph);
        },
        { onUpdate: resolve },
      );
    });

    editor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChild();
      const children = $isElementNode(paragraph) ? paragraph.getChildren() : [];
      expect($isTextNode(children[0])).toBe(true);
      expect($isGoalCommandNode(children[1])).toBe(true);
      expect($getRoot().getTextContent()).toBe('  /goal Finish the migration');
    });
  });
});
