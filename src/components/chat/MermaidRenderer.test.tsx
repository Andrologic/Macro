import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';

const translationMock = createTranslationMock({
  'chat.renderingDiagram': 'Rendering diagram...',
  'chat.mermaidRenderError': 'Unable to render Mermaid diagram',
  'chat.mermaidDiagram': 'Mermaid diagram',
  'chat.copied': 'Copied',
  'chat.copyCode': 'Copy code',
  'chat.hideCode': 'Hide code',
  'chat.showCode': 'Show code',
  'chat.expand': 'Expand',
  'common.close': 'Close',
});

describe('MermaidRenderer cache', () => {
  it('never grows beyond its configured limit and evicts the least recently used entry', async () => {
    const { __testables } = await import(`./MermaidRenderer.tsx?cache-limit-test=${Date.now()}`);
    const cache = __testables.createBoundedLruCache(__testables.MAX_MERMAID_CACHE_ENTRIES);

    for (let index = 0; index <= __testables.MAX_MERMAID_CACHE_ENTRIES; index += 1) {
      cache.set(`diagram-${index}`, `<svg>${index}</svg>`);
    }

    expect(cache.size).toBe(__testables.MAX_MERMAID_CACHE_ENTRIES);
    expect(cache.get('diagram-0')).toBeUndefined();
    expect(cache.get('diagram-1')).toBe('<svg>1</svg>');
  });

  it('keeps a cache hit by refreshing its recency', async () => {
    const { __testables } = await import(`./MermaidRenderer.tsx?cache-recency-test=${Date.now()}`);
    const cache = __testables.createBoundedLruCache(3);

    cache.set('first', '<svg>first</svg>');
    cache.set('second', '<svg>second</svg>');
    cache.set('third', '<svg>third</svg>');
    expect(cache.get('first')).toBe('<svg>first</svg>');
    cache.set('fourth', '<svg>fourth</svg>');

    expect(cache.size).toBe(3);
    expect(cache.get('second')).toBeUndefined();
    expect(cache.get('first')).toBe('<svg>first</svg>');
  });
});

describe('MermaidRenderer security', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    container = null;
    root = null;
    document.body.innerHTML = '';
    globalThis.IntersectionObserver = originalIntersectionObserver;
    mock.restore();
  });

  it('initializes Mermaid with strict security for rendered diagrams', async () => {
    const initialize = mock(() => undefined);
    const parse = mock(async () => true);
    const render = mock(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Safe</text></svg>',
    }));

    installReactI18nextMock(translationMock);
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    mock.module('../theme/ThemeProvider', () => ({
      useTheme: () => ({ isDark: false }),
    }));
    mock.module('mermaid', () => ({
      default: {
        initialize,
        parse,
        render,
      },
    }));

    const { MermaidRenderer } = await import(`./MermaidRenderer.tsx?security-test=${Date.now()}`);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<MermaidRenderer code={'graph TD\nA-->B'} blockKey={1} />);
    });
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 64));
    });

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
      }),
    );
    expect(parse).toHaveBeenCalledWith('graph TD\nA-->B', { suppressErrors: true });
  });

  it('removes executable SVG content before injection', async () => {
    const { sanitizeMermaidSvg } = await import(`./MermaidRenderer.tsx?sanitize-test=${Date.now()}`);

    const sanitized = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <script>alert(1)</script>
        <foreignObject><div onclick="alert(1)">bad</div></foreignObject>
        <a href="javascript:alert(1)" onclick="alert(1)">
          <text style="background: url(javascript:alert(1))">link</text>
        </a>
      </svg>
    `);

    expect(sanitized).toContain('<svg');
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('<foreignObject');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).not.toContain('onclick');
  });

  it('reports a clipboard error without showing a false copied state', async () => {
    const notifyError = mock(() => undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mock(async () => { throw new Error('blocked'); }) },
    });
    installReactI18nextMock(translationMock);
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    mock.module('../theme/ThemeProvider', () => ({ useTheme: () => ({ isDark: false }) }));
    mock.module('../ui/toastService', () => ({ notify: { error: notifyError } }));
    mock.module('mermaid', () => ({
      default: { initialize: mock(() => undefined), parse: mock(async () => true), render: mock(async () => ({ svg: '<svg />' })) },
    }));
    const { MermaidRenderer } = await import(`./MermaidRenderer.tsx?copy-error-test=${Date.now()}`);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<MermaidRenderer code={'graph TD\nA-->B'} blockKey={2} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 32));
    });
    const copyButton = document.body.querySelector<HTMLButtonElement>('[title="Copy code"]');
    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });

    expect(notifyError).toHaveBeenCalledWith('Unable to copy the diagram code.');
    expect(copyButton?.getAttribute('title')).toBe('Copy code');
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  });
});
