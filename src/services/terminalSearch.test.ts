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
