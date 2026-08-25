import type { Chunk } from '@codemirror/merge';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export type RevertControls = 'a-to-b' | 'b-to-a';
export type RevertAnchorSide = 'a' | 'b';

type MergeChangeLike = Pick<Chunk['changes'][number], 'fromA' | 'toA' | 'fromB' | 'toB'>;
type ChunkLike = Pick<Chunk, 'changes' | 'fromA' | 'fromB'>;

export interface EditorGeometryReader {
  coordsAtPos: EditorView['coordsAtPos'];
  lineBlockAt: EditorView['lineBlockAt'];
  documentTop: number;
  state: Pick<EditorState, 'doc'>;
}

export interface MergeViewAlignmentReader {
  a: EditorGeometryReader;
  b: EditorGeometryReader;
  chunks: readonly ChunkLike[];
}

export interface RevertButtonPosition {
  button: HTMLElement;
  top: number;
}

const isFiniteNumber = (value: number): boolean => Number.isFinite(value);

const clampDocumentPosition = (editor: EditorGeometryReader, pos: number): number =>
  Math.max(0, Math.min(pos, editor.state.doc.length));

const getTargetRange = (
  chunk: ChunkLike,
  change: MergeChangeLike,
  side: RevertAnchorSide
): { from: number; to: number } => {
  if (side === 'a') {
    return {
      from: chunk.fromA + change.fromA,
      to: chunk.fromA + change.toA,
    };
  }

  return {
    from: chunk.fromB + change.fromB,
    to: chunk.fromB + change.toB,
  };
};

export const resolveRevertAnchorSide = (
  revertControls?: RevertControls
): RevertAnchorSide | null => {
  if (revertControls === 'a-to-b') {
    return 'b';
  }
  if (revertControls === 'b-to-a') {
    return 'a';
  }
  return null;
};

export const getChunkAnchorPosition = (
  chunk: ChunkLike,
  side: RevertAnchorSide
): number | null => {
  for (const change of chunk.changes) {
    const { from, to } = getTargetRange(chunk, change, side);
    if (to > from) {
      return from;
    }
  }

  return null;
};

export const getChunkFallbackTop = (
  chunk: ChunkLike,
  editor: EditorGeometryReader,
  side: RevertAnchorSide
): number => {
  const chunkStart = side === 'a' ? chunk.fromA : chunk.fromB;
  return editor.lineBlockAt(clampDocumentPosition(editor, chunkStart)).top;
};

export const getChunkAnchorTop = (
  chunk: ChunkLike,
  editor: EditorGeometryReader,
  side: RevertAnchorSide
): number => {
  const anchorPos = getChunkAnchorPosition(chunk, side);
  if (anchorPos == null) {
    return getChunkFallbackTop(chunk, editor, side);
  }

  const rect = editor.coordsAtPos(clampDocumentPosition(editor, anchorPos), 1);
  if (!rect || !isFiniteNumber(rect.top)) {
    return getChunkFallbackTop(chunk, editor, side);
  }

  return rect.top - editor.documentTop;
};

export const collectRevertButtonPositions = (
  mergeView: MergeViewAlignmentReader,
  revertControls: RevertControls | undefined,
  buttons: readonly HTMLElement[]
): RevertButtonPosition[] => {
  const anchorSide = resolveRevertAnchorSide(revertControls);
  if (!anchorSide) {
    return [];
  }

  const editor = anchorSide === 'a' ? mergeView.a : mergeView.b;
  const positions: RevertButtonPosition[] = [];

  buttons.forEach((button, buttonIndex) => {
    const parsedChunkIndex = Number.parseInt(button.dataset.chunk ?? '', 10);
    const chunkIndex = Number.isInteger(parsedChunkIndex)
      ? parsedChunkIndex
      : buttonIndex;

    const chunk = mergeView.chunks[chunkIndex];
    if (!chunk) {
      return;
    }

    positions.push({
      button,
      top: getChunkAnchorTop(chunk, editor, anchorSide),
    });
  });

  return positions;
};
