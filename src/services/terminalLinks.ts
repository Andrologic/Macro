import type { ILink, ILinkProvider } from 'xterm';

const TERMINAL_URL_PATTERN =
  /\b(?:https?:\/\/|www\.|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5})[^\s<>"'`{}|\\^\]]*/gi;
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
  openUrl: TerminalUrlOpener
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
          x: startIndex + 1,
          y: bufferLineNumber,
        },
        end: {
          x: endIndexExclusive,
          y: bufferLineNumber,
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
        getLine: (index: number) => { translateToString(trimRight?: boolean): string } | undefined;
      };
    };
  },
  openUrl: TerminalUrlOpener
): ILinkProvider => ({
  provideLinks(bufferLineNumber, callback) {
    const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }

    callback(detectTerminalLinksInLine(line.translateToString(true), bufferLineNumber, openUrl));
  },
});
