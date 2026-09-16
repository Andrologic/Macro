import type { IBufferLine, ILink, ILinkProvider } from 'xterm';

const TERMINAL_URL_PATTERN =
  /\b(?:https?:\/\/|www\.|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5})[^\s<>"'`{}|\\^]*/gi;
const SIMPLE_TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);
const BALANCED_CLOSERS: Record<string, string> = {
  ')': '(',
  ']': '[',
};

export type TerminalUrlOpener = (url: string) => void | Promise<void>;

const countChar = (value: string, char: string): number => {
  let count = 0;
  for (const current of value) {
    if (current === char) {
      count += 1;
    }
  }
  return count;
};

export const trimTerminalUrlToken = (rawToken: string): string => {
  let token = rawToken.trim();

  while (token.length > 0) {
    const last = token[token.length - 1];
    if (!last) {
      break;
    }

    if (SIMPLE_TRAILING_PUNCTUATION.has(last)) {
      token = token.slice(0, -1);
      continue;
    }

    const opener = BALANCED_CLOSERS[last];
    if (opener && countChar(token, last) > countChar(token, opener)) {
      token = token.slice(0, -1);
      continue;
    }

    break;
  }

  return token;
};

export const normalizeTerminalUrl = (rawToken: string): string | null => {
  const trimmed = trimTerminalUrlToken(rawToken);
  if (!trimmed) {
    return null;
  }

  const lowerTrimmed = trimmed.toLowerCase();
  const candidate =
    lowerTrimmed.startsWith('www.')
      ? `https://${trimmed}`
      : /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(?:[/?#].*)?$/i.test(trimmed)
        ? `http://${trimmed}`
        : trimmed;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.hostname === '0.0.0.0') {
      parsed.hostname = 'localhost';
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

export const detectTerminalLinksInLine = (
  lineText: string,
  bufferLineNumber: number,
  openUrl: TerminalUrlOpener,
  positions?: Array<{ x: number; y: number; endX: number }>
): ILink[] | undefined => {
  const links: ILink[] = [];
  const matcher = new RegExp(TERMINAL_URL_PATTERN);
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(lineText)) !== null) {
    const rawToken = match[0];
    const linkText = trimTerminalUrlToken(rawToken);
    const normalizedUrl = normalizeTerminalUrl(linkText);
    if (!linkText || !normalizedUrl) {
      continue;
    }

    const startIndex = match.index;
    const endIndexExclusive = startIndex + linkText.length;
    if (endIndexExclusive <= startIndex) {
      continue;
    }

    links.push({
      text: linkText,
      range: {
        start: {
          x: positions?.[startIndex]?.x ?? startIndex + 1,
          y: positions?.[startIndex]?.y ?? bufferLineNumber,
        },
        end: {
          x: positions?.[endIndexExclusive - 1]?.endX ?? endIndexExclusive,
          y: positions?.[endIndexExclusive - 1]?.y ?? bufferLineNumber,
        },
      },
      decorations: {
        pointerCursor: true,
        underline: true,
      },
      activate: (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void openUrl(normalizedUrl);
      },
    });
  }

  return links.length > 0 ? links : undefined;
};

export const createTerminalUrlLinkProvider = (
  terminal: {
    buffer: {
      active: {
        getLine: (index: number) => IBufferLine | undefined;
      };
    };
  },
  openUrl: TerminalUrlOpener
): ILinkProvider => ({
  provideLinks(bufferLineNumber, callback) {
    const buffer = terminal.buffer.active;
    let first = bufferLineNumber - 1;
    let line = buffer.getLine(first);
    if (!line) {
      callback(undefined);
      return;
    }
    while (first > 0 && line.isWrapped) {
      const previous = buffer.getLine(first - 1);
      if (!previous) break;
      line = previous;
      first -= 1;
    }

    let text = '';
    const positions: Array<{ x: number; y: number; endX: number }> = [];
    for (let row = first; line; row += 1) {
      const next = buffer.getLine(row + 1);
      const wraps = next?.isWrapped === true;
      // A wide cell wrapping from the last column leaves a null padding cell.
      // It is not a space in the logical text.
      const paddedWideWrap = wraps && next?.getCell(0)?.getWidth() === 2 &&
        line.getCell(line.length - 1)?.getCode() === 0 &&
        line.getCell(line.length - 1)?.getWidth() === 1;
      const endColumn = line.length - (paddedWideWrap ? 1 : 0);
      const rowText = line.translateToString(!wraps, 0, endColumn);
      let offset = 0;
      for (let column = 0; column < endColumn && offset < rowText.length; column += 1) {
        const cell = line.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        for (let index = 0; index < chars.length; index += 1) {
          positions.push({ x: column + 1, y: row + 1, endX: column + cell.getWidth() });
        }
        offset += chars.length;
      }
      text += rowText;
      if (!wraps) break;
      line = next;
    }
    const links = detectTerminalLinksInLine(text, first + 1, openUrl, positions)?.filter(
      (link) => link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber
    );
    callback(links?.length ? links : undefined);
  },
});
