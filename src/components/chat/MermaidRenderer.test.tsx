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
});
