import type { ILink } from 'xterm';
import { describe, expect, it, mock, spyOn } from 'bun:test';
import {
  createTerminalUrlLinkProvider,
  detectTerminalLinksInLine,
  normalizeTerminalUrl,
  trimTerminalUrlToken,
} from './terminalLinks';

// These tests use xterm's real buffer without opening a canvas renderer.
const canvasContext = spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
const { Terminal } = await import('xterm');
canvasContext.mockRestore();

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

  const bufferLinks = async (text: string, cols = 100, row = 1) => {
    const terminal = new Terminal({ cols, rows: 10, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(text, resolve));
    const open = mock(() => undefined);
    const provider = createTerminalUrlLinkProvider(terminal, open);
    let links: ILink[] | undefined;
    provider.provideLinks(row, (result) => { links = result; });
    terminal.dispose();
    return { links, open };
  };

  it('maps CJK, combining accents and emoji to xterm cells', async () => {
    for (const [prefix, column] of [['界界 ', 6], ['e\u0301 ', 3], ['😀 ', 3]] as const) {
      const { links } = await bufferLinks(`${prefix}https://example.com/a`);
      expect(links?.[0]?.range).toEqual({
        start: { x: column, y: 1 }, end: { x: column + 20, y: 1 },
      });
    }
  });

  it('opens a complete URL across wrapped lines from either row', async () => {
    const url = 'https://example.com/docs/abcdefghijklmnopqrstuvwxyz?filter[status]=ok';
    for (const row of [1, 2, 3]) {
      const { links, open } = await bufferLinks(`see ${url}`, 30, row);
      expect(links?.[0]?.text).toBe(url);
      expect(links?.[0]?.range).toEqual({
        start: { x: 5, y: 1 }, end: { x: (4 + url.length - 1) % 30 + 1, y: 3 },
      });
      links?.[0]?.activate({ button: 0, preventDefault() {}, stopPropagation() {} } as MouseEvent, url);
      expect(open).toHaveBeenCalledWith(url);
    }
  });

  it('keeps Unicode URL endings and adjacent links on their own cells', async () => {
    const { links } = await bufferLinks('https://e.test/界 https://a.test/');
    expect(links?.map((link) => link.text)).toEqual(['https://e.test/界', 'https://a.test/']);
    expect(links?.[0]?.range.end).toEqual({ x: 17, y: 1 });
    expect(links?.[1]?.range.start).toEqual({ x: 19, y: 1 });
  });

  it('ignores the padding cell before a wide character wraps', async () => {
    const url = 'https://e.test/界/path';
    const { links } = await bufferLinks(url, 16, 2);
    expect(links?.[0]?.text).toBe(url);
    expect(links?.[0]?.range.start).toEqual({ x: 1, y: 1 });
  });

  it('keeps explicit newlines separate and balanced brackets in URLs', async () => {
    const { links } = await bufferLinks('http://[::1]:5173/\r\nhttps://example.com/?filter[status]=ok');
    expect(links?.[0]?.text).toBe('http://[::1]:5173/');
    const query = detectTerminalLinksInLine('[https://example.com/?a[b]=c].', 1, () => undefined);
    expect(query?.[0]?.text).toBe('https://example.com/?a[b]=c');
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
