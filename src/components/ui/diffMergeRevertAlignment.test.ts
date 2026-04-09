import { describe, expect, it } from 'bun:test';
import { Change, Chunk } from '@codemirror/merge';
import {
  collectRevertButtonPositions,
  getChunkAnchorPosition,
  getChunkAnchorTop,
  getChunkFallbackTop,
  resolveRevertAnchorSide,
  type EditorGeometryReader,
} from './diffMergeRevertAlignment';

const createEditor = ({
  docLength = 200,
  rectTopByPos = {},
  fallbackTop = 24,
}: {
  docLength?: number;
  rectTopByPos?: Record<number, number | null>;
  fallbackTop?: number;
} = {}): EditorGeometryReader => ({
  coordsAtPos: (pos) => {
    const rectTop = rectTopByPos[pos];
    return rectTop == null ? null : ({ top: rectTop } as any);
  },
  lineBlockAt: () => ({ top: fallbackTop } as any),
  documentTop: 20,
  state: {
    doc: {
      length: docLength,
    },
  } as any,
});

describe('diffMergeRevertAlignment', () => {
  it('anchors a-to-b reverts on the first non-empty change in editor b', () => {
    const chunk = new Chunk(
      [
        new Change(0, 0, 0, 0),
        new Change(4, 4, 4, 9),
      ],
      10,
      10,
      20,
      29
    );

    expect(resolveRevertAnchorSide('a-to-b')).toBe('b');
    expect(getChunkAnchorPosition(chunk, 'b')).toBe(24);
  });

  it('anchors b-to-a reverts on the first non-empty change in editor a', () => {
    const chunk = new Chunk(
      [
        new Change(0, 0, 0, 5),
        new Change(8, 13, 13, 13),
      ],
      40,
      53,
      80,
      93
    );

    expect(resolveRevertAnchorSide('b-to-a')).toBe('a');
    expect(getChunkAnchorPosition(chunk, 'a')).toBe(48);
  });

  it('falls back to the logical line top for pure deletions on the anchor side', () => {
    const chunk = new Chunk([new Change(0, 5, 0, 0)], 12, 17, 32, 32);
    const editor = createEditor({ fallbackTop: 140 });

    expect(getChunkAnchorPosition(chunk, 'b')).toBeNull();
    expect(getChunkFallbackTop(chunk, editor, 'b')).toBe(140);
    expect(getChunkAnchorTop(chunk, editor, 'b')).toBe(140);
  });

  it('converts screen coordinates into document-relative tops', () => {
    const chunk = new Chunk([new Change(0, 5, 0, 5)], 10, 15, 20, 25);
    const editor = createEditor({
      rectTopByPos: {
        20: 188,
      },
      fallbackTop: 100,
    });

    expect(getChunkAnchorTop(chunk, editor, 'b')).toBe(168);
  });

  it('collects positions only for buttons with valid chunk indices', () => {
    const mergeView = {
      a: createEditor({ rectTopByPos: { 10: 120 } }),
      b: createEditor({ rectTopByPos: { 20: 220 } }),
      chunks: [new Chunk([new Change(0, 3, 0, 6)], 10, 13, 20, 26)],
    };
    const button = document.createElement('button');
    button.dataset.chunk = '0';
    const invalidButton = document.createElement('button');
    invalidButton.dataset.chunk = 'nope';

    const positions = collectRevertButtonPositions(mergeView, 'a-to-b', [button, invalidButton]);

    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual({ button, top: 200 });
  });
});
