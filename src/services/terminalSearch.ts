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

interface CaseFoldedText {
  text: string;
  originalStarts: number[];
  originalEnds: number[];
}

const foldCaseWithOriginalIndices = (value: string): CaseFoldedText => {
  const originalStarts: number[] = [];
  const originalEnds: number[] = [];
  let originalIndex = 0;

  for (const character of value) {
    const originalEnd = originalIndex + character.length;
    const foldedLength = character.toLowerCase().length;

    for (let foldedIndex = 0; foldedIndex < foldedLength; foldedIndex += 1) {
      originalStarts.push(originalIndex);
      originalEnds.push(originalEnd);
    }

    originalIndex = originalEnd;
  }

  return {
    text: value.toLowerCase(),
    originalStarts,
    originalEnds,
  };
};

export const findTerminalSearchMatches = (
  terminal: SearchableTerminalBuffer,
  query: string
): TerminalSearchMatch[] => {
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();
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
    const foldedText = foldCaseWithOriginalIndices(text);
    let searchFrom = 0;
    while (searchFrom <= foldedText.text.length - normalizedQuery.length) {
      const foldedColumn = foldedText.text.indexOf(normalizedQuery, searchFrom);
      if (foldedColumn === -1) {
        break;
      }

      const foldedEnd = foldedColumn + normalizedQuery.length - 1;
      const column = foldedText.originalStarts[foldedColumn];
      const originalEnd = foldedText.originalEnds[foldedEnd];
      if (column === undefined || originalEnd === undefined) {
        break;
      }

      matches.push({
        row,
        column,
        length: originalEnd - column,
      });
      searchFrom = foldedColumn + Math.max(1, normalizedQuery.length);
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
