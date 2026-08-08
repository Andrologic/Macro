import type { Terminal } from 'xterm';

export type TerminalSearchDirection = 'next' | 'previous';

export interface TerminalSearchMatch {
  row: number;
  column: number;
  length: number;
}

export interface TerminalSearchResult {
  matchIndex: number;
  matchCount: number;
}

interface SearchableTerminalBuffer {
  buffer: {
    active: {
      length: number;
      getLine: (index: number) => { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

export const findTerminalSearchMatches = (
  terminal: SearchableTerminalBuffer,
  query: string
): TerminalSearchMatch[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const buffer = terminal.buffer.active;
  const matches: TerminalSearchMatch[] = [];

  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      continue;
    }

    const text = line.translateToString(true);
    const normalizedText = text.toLowerCase();
    let searchFrom = 0;
    while (searchFrom <= normalizedText.length - normalizedQuery.length) {
      const column = normalizedText.indexOf(normalizedQuery, searchFrom);
      if (column === -1) {
        break;
      }

      matches.push({
        row,
        column,
        length: query.trim().length,
      });
      searchFrom = column + Math.max(1, normalizedQuery.length);
    }
  }

  return matches;
};

export const getNextTerminalSearchIndex = (
  matchCount: number,
  currentIndex: number | null | undefined,
  direction: TerminalSearchDirection
): number | null => {
  if (matchCount <= 0) {
    return null;
  }

  if (currentIndex === null || currentIndex === undefined || currentIndex < 0 || currentIndex >= matchCount) {
    return direction === 'previous' ? matchCount - 1 : 0;
  }

  return direction === 'previous'
    ? (currentIndex - 1 + matchCount) % matchCount
    : (currentIndex + 1) % matchCount;
};

export const selectTerminalSearchMatch = (
  terminal: Pick<Terminal, 'select' | 'scrollToLine' | 'focus'>,
  match: TerminalSearchMatch,
  focusTerminal = true
): void => {
  terminal.scrollToLine(match.row);
  terminal.select(match.column, match.row, match.length);
  if (focusTerminal) {
    terminal.focus();
  }
};
