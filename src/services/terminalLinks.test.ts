import { describe, expect, it, mock } from 'bun:test';
import {
  createTerminalUrlLinkProvider,
  detectTerminalLinksInLine,
  normalizeTerminalUrl,
  trimTerminalUrlToken,
} from './terminalLinks';

describe('terminalLinks', () => {
  it('normalizes HTTP URLs and strips terminal-friendly trailing punctuation', () => {
    expect(normalizeTerminalUrl('https://example.com/docs.')).toBe('https://example.com/docs');
    expect(normalizeTerminalUrl('(https://example.com/docs)')).toBeNull();
    expect(trimTerminalUrlToken('https://example.com/path).')).toBe('https://example.com/path');
    expect(trimTerminalUrlToken('https://example.com/path(foo).')).toBe('https://example.com/path(foo)');
  });

  it('turns www links into HTTPS URLs and ignores non-HTTP protocols', () => {
    expect(normalizeTerminalUrl('www.example.com/path')).toBe('https://www.example.com/path');
    expect(normalizeTerminalUrl('ftp://example.com/path')).toBeNull();
  });

  it('normalizes local dev server ports into clickable HTTP URLs', () => {
    expect(normalizeTerminalUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeTerminalUrl('127.0.0.1:5173/path')).toBe('http://127.0.0.1:5173/path');
    expect(normalizeTerminalUrl('0.0.0.0:8080')).toBe('http://localhost:8080/');
  });

  it('detects URL ranges on a terminal buffer line and opens the normalized URL', () => {
    const openUrl = mock(() => undefined);
    const links = detectTerminalLinksInLine(
      'Open https://example.com/docs, then www.macro.dev.',
      4,
      openUrl
    );

    expect(links).toHaveLength(2);
    expect(links?.[0]?.text).toBe('https://example.com/docs');
    expect(links?.[0]?.range).toEqual({
      start: { x: 6, y: 4 },
      end: { x: 29, y: 4 },
    });
    expect(links?.[1]?.text).toBe('www.macro.dev');
    expect(links?.[1]?.range).toEqual({
      start: { x: 37, y: 4 },
      end: { x: 49, y: 4 },
    });

    const event = {
      button: 0,
      preventDefault: mock(() => undefined),
      stopPropagation: mock(() => undefined),
    } as unknown as MouseEvent;
    links?.[1]?.activate(event, links[1].text);

    expect(openUrl).toHaveBeenCalledWith('https://www.macro.dev/');
  });

  it('does not open links for non-primary mouse buttons', () => {
    const openUrl = mock(() => undefined);
    const links = detectTerminalLinksInLine('https://example.com', 1, openUrl);

    links?.[0]?.activate({ button: 1 } as MouseEvent, links[0].text);

    expect(openUrl).not.toHaveBeenCalled();
  });

  it('builds an xterm link provider from terminal buffer lines', () => {
    const provider = createTerminalUrlLinkProvider(
      {
        buffer: {
          active: {
            getLine: (index: number) =>
              index === 2
                ? { translateToString: () => 'server: http://localhost:5173' }
                : undefined,
          },
        },
      },
      () => undefined
    );
    let providedCount = 0;

    provider.provideLinks(3, (links) => {
      providedCount = links?.length ?? 0;
    });

    expect(providedCount).toBe(1);
  });

  it('detects localhost ports without requiring a URL scheme', () => {
    const openUrl = mock(() => undefined);
    const links = detectTerminalLinksInLine(
      'Vite ready at localhost:5173 and 0.0.0.0:4173.',
      2,
      openUrl
    );

    expect(links).toHaveLength(2);
    expect(links?.[0]?.text).toBe('localhost:5173');
    links?.[1]?.activate(
      { button: 0, preventDefault: () => undefined, stopPropagation: () => undefined } as MouseEvent,
      links[1].text
    );

    expect(openUrl).toHaveBeenCalledWith('http://localhost:4173/');
  });
});
