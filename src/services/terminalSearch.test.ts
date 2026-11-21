import { describe, expect, it, mock } from 'bun:test';
import {
  findTerminalSearchMatches,
  getNextTerminalSearchIndex,
  selectTerminalSearchMatch,
} from './terminalSearch';

const buildTerminal = (lines: string[]) => ({
  buffer: {
    active: {
      length: lines.length,
      getLine: (index: number) =>
        lines[index] === undefined
          ? undefined
          : { translateToString: () => lines[index] },
    },
  },
});

describe('terminalSearch', () => {
  it('finds case-insensitive matches across terminal buffer lines', () => {
    const matches = findTerminalSearchMatches(
      buildTerminal(['Vite ready', 'running vite build', 'done']),
      'vite'
    );

    expect(matches).toEqual([
      { row: 0, column: 0, length: 4 },
      { row: 1, column: 8, length: 4 },
    ]);
  });

  it('keeps original columns and selection lengths when Unicode case folding expands text', () => {
    const matches = findTerminalSearchMatches(
      buildTerminal(['🧪İ ERROR', 'Code İ OK']),
      'i'
    );

    expect(matches).toEqual([
      { row: 0, column: 2, length: 1 },
      { row: 1, column: 5, length: 1 },
    ]);

    expect(findTerminalSearchMatches(buildTerminal(['İstanbul ERROR']), 'error')).toEqual([
      { row: 0, column: 9, length: 5 },
    ]);
  });

  it('preserves ASCII offsets, non-overlapping matches, row order and query trimming', () => {
    expect(findTerminalSearchMatches(
      buildTerminal(['\x00AaAa\x7f', '', 'MATCH match MATCH', 'no result']),
      '  aa  '
    )).toEqual([
      { row: 0, column: 1, length: 2 },
      { row: 0, column: 3, length: 2 },
    ]);
    expect(findTerminalSearchMatches(buildTerminal(['aaaaa']), 'aaa')).toEqual([
      { row: 0, column: 0, length: 3 },
    ]);
    expect(findTerminalSearchMatches(buildTerminal(['MATCH match', 'match']), 'match')).toEqual([
      { row: 0, column: 0, length: 5 },
      { row: 0, column: 6, length: 5 },
      { row: 1, column: 0, length: 5 },
    ]);
    expect(findTerminalSearchMatches(buildTerminal(['match']), '   ')).toEqual([]);
    expect(findTerminalSearchMatches(buildTerminal(['match']), 'absent')).toEqual([]);
  });

  it('preserves mixed Unicode offsets, contextual lowercase and expanding queries', () => {
    const terminal = buildTerminal(['ASCII İ match', '🧪İ ERROR', 'ΟΣ', '\x80MATCH', '\ud800MATCH']);
    expect(findTerminalSearchMatches(terminal, 'match')).toEqual([
      { row: 0, column: 8, length: 5 },
      { row: 3, column: 1, length: 5 },
      { row: 4, column: 1, length: 5 },
    ]);
    expect(findTerminalSearchMatches(terminal, 'İ')).toEqual([
      { row: 0, column: 6, length: 1 },
      { row: 1, column: 2, length: 1 },
    ]);
    expect(findTerminalSearchMatches(terminal, 'ος')).toEqual([
      { row: 2, column: 0, length: 2 },
    ]);
    expect(findTerminalSearchMatches(buildTerminal(['ASCII']), 'İ')).toEqual([]);
  });

  it('cycles forward and backward through matches', () => {
    expect(getNextTerminalSearchIndex(3, null, 'next')).toBe(0);
    expect(getNextTerminalSearchIndex(3, 2, 'next')).toBe(0);
    expect(getNextTerminalSearchIndex(3, 0, 'previous')).toBe(2);
    expect(getNextTerminalSearchIndex(0, 0, 'next')).toBeNull();
  });

  it('selects and scrolls to the active match', () => {
    const terminal = {
      scrollToLine: mock(() => undefined),
      select: mock(() => undefined),
      focus: mock(() => undefined),
    };

    selectTerminalSearchMatch(terminal, { row: 12, column: 4, length: 6 });

    expect(terminal.scrollToLine).toHaveBeenCalledWith(12);
    expect(terminal.select).toHaveBeenCalledWith(4, 12, 6);
    expect(terminal.focus).toHaveBeenCalled();
  });
});
