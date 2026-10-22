import { buildProviderErrorTranscriptMarkdown, resolveChatErrorPresentation } from '../../services/chatErrorPresentation';
import { describe, expect, it, spyOn } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { notify } from '../ui/toastService';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  isMarkdownVideo,
  MarkdownRichContent,
  normalizeLatexBracketMath,
} from './MarkdownRichContent';

describe('normalizeLatexBracketMath', () => {
  it('returns the original string when no latex bracket delimiters are present', () => {
    const content = 'No math here, only regular markdown.';

    expect(normalizeLatexBracketMath(content)).toBe(content);
  });

  it('converts inline latex paren math to remark-math delimiters', () => {
    expect(normalizeLatexBracketMath(String.raw`\(R^2\)`)).toBe('$R^2$');
  });

  it('converts display latex bracket math to remark-math delimiters', () => {
    expect(normalizeLatexBracketMath(String.raw`\[ R^2 = 0{,}47 \]`)).toBe('$$ R^2 = 0{,}47 $$');
  });

  it('converts multiline display math', () => {
    const input = `\\[
R^2 = 0{,}47
\\]`;

    expect(normalizeLatexBracketMath(input)).toBe(`$$
R^2 = 0{,}47
$$`);
  });

  it('keeps existing dollar-delimited math unchanged', () => {
    const content = '$R^2$ and $$\nR^2 = 0{,}47\n$$';

    expect(normalizeLatexBracketMath(content)).toBe(content);
  });

  it('does not convert delimiters inside inline code', () => {
    const content = 'Keep \\(\\alpha\\), but not `\\(R^2\\)`.';

    expect(normalizeLatexBracketMath(content)).toBe('Keep $\\alpha$, but not `\\(R^2\\)`.');
  });

  it('does not convert delimiters inside fenced code blocks', () => {
    const content = [
      'Before \\(x\\)',
      '```md',
      '\\[R^2\\]',
      '```',
      'After \\(y\\)',
    ].join('\n');

    expect(normalizeLatexBracketMath(content)).toBe([
      'Before $x$',
      '```md',
      '\\[R^2\\]',
      '```',
      'After $y$',
    ].join('\n'));
  });

  it('leaves unmatched delimiters unchanged', () => {
    const content = String.raw`Open \(R^2 and \[value`;

    expect(normalizeLatexBracketMath(content)).toBe(content);
  });
});

describe('MarkdownRichContent math rendering', () => {
  it('renders latex bracket display math with KaTeX instead of visible markdown brackets', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={`\\[\nR^2 = 0{,}47\n\\]`} />
    );

    expect(markup).toContain('class="katex-display"');
    expect(markup).toContain('annotation encoding="application/x-tex">R^2 = 0{,}47</annotation>');
    expect(markup).not.toContain('<p>[');
  });
});

describe('MarkdownRichContent media rendering', () => {
  it('renders Markdown images in a lazy, contained media frame', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent
        content={'![Macro workspace](/release-notes/0.1.0/workspace.webp "The new workspace")'}
      />
    );

    expect(markup).toContain('<img');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('src="/release-notes/0.1.0/workspace.webp"');
    expect(markup).toContain('The new workspace');
  });

  it('renders supported video files with native controls', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent
        content={'![Feature demo](/release-notes/0.1.0/demo.webm)'}
      />
    );

    expect(markup).toContain('<video');
    expect(markup).toContain('controls=""');
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain('src="/release-notes/0.1.0/demo.webm"');
  });

  it('supports the video prefix when the URL has no file extension', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'![video: Feature demo](/release-notes/demo)'} />
    );

    expect(isMarkdownVideo('/release-notes/demo', 'video: Feature demo')).toBe(true);
    expect(markup).toContain('<video');
    expect(markup).toContain('aria-label="Feature demo"');
  });

  it('waits for an explicit click before loading a remote image', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<MarkdownRichContent content={'![Tracking pixel](https://images.example/pixel.png)'} />);
      });

      expect(container.querySelector('img')).toBeNull();
      const loadButton = container.querySelector('button');
      expect(loadButton?.textContent).toContain('images.example');

      await act(async () => { loadButton?.click(); });
      expect(container.querySelector('img')?.getAttribute('src')).toBe('https://images.example/pixel.png');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('blocks protocol-relative images and remote videos until clicked', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<MarkdownRichContent content={
          '![Pixel](//images.example/pixel.png)\n\n![video: Demo](https://videos.example/demo.mp4)'
        } />);
      });

      expect(container.querySelector('img, video')).toBeNull();
      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.map((button) => button.textContent)).toEqual([
        expect.stringContaining('images.example'),
        expect.stringContaining('videos.example'),
      ]);

      await act(async () => { buttons[1]?.click(); });
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('video')?.getAttribute('src')).toBe('https://videos.example/demo.mp4');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});

describe('MarkdownRichContent code block rendering', () => {
  it('keeps horizontal scrolling on the padded container', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'```text\nconst value = "a long line";\n```'} />
    );

    expect(markup).toContain('<pre class="markdown-code-scroll');
    expect(markup).toContain('overflow-x-auto');
    expect(markup).toContain('class="text-sm font-mono whitespace-pre hljs-code"');
  });

  it('renders a one-line fence without a language as a block', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'```\none line\n```'} />
    );

    expect(markup).toContain('<pre class="markdown-code-scroll');
    expect(markup).toContain('>one ');
    expect(markup).toContain('>line</span>');
  });

  it('keeps inline code inline', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'Use `one line` inline.'} />
    );

    expect(markup).not.toContain('<pre');
    expect(markup).toContain('<code');
  });
});

describe('MarkdownRichContent context references', () => {
  it('renders inline skill references as chips inside normal markdown text', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'XXXXX[skill: test-skill]XXXX\n\nNickel'} />
    );

    expect(markup).toContain('data-context-reference-kind="skill"');
    expect(markup).toContain('data-context-reference-surface="message"');
    expect(markup).toContain('XXXXX');
    expect(markup).toContain('XXXX');
    expect(markup).not.toContain('[skill: test-skill]');
  });

  it('renders source references as chips inside normal markdown text', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'Sources: [source: product brief]'} />
    );

    expect(markup).toContain('data-context-reference-kind="source"');
    expect(markup).toContain('data-context-reference-surface="message"');
    expect(markup).not.toContain('[source: product brief]');
  });

  it('renders context reference chips in markdown table cells', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent
        content={[
          '| Action | Detail |',
          '| --- | --- |',
          '| Activer | [skill: test-skill] - déjà fait |',
        ].join('\n')}
      />
    );

    expect(markup).toContain('<td');
    expect(markup).toContain('data-context-reference-kind="skill"');
    expect(markup).not.toContain('[skill: test-skill]');
  });

  it('renders stable AgSDL references without exposing internal links', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'Inspect [agsdl: Release](macro-context://agsdl/selection-1)'} />,
    );
    expect(markup).toContain('data-context-reference-kind="agsdl"');
    expect(markup).not.toContain('href="macro-context:');
  });

  it('does not render context reference chips inside inline code', () => {
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'Keep `[skill: test-skill]` literal'} />
    );

    expect(markup).toContain('[skill: test-skill]');
    expect(markup).not.toContain('data-context-reference-kind="skill"');
  });
});


describe('MarkdownRichContent clipboard', () => {
  it('announces copying only after success and permits retry after rejection', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let resolveCopy!: () => void;
    let rejectCopy!: (error: Error) => void;
    const copy = spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>((resolve, reject) => {
      resolveCopy = resolve;
      rejectCopy = reject;
    }));
    const error = spyOn(notify, 'error').mockImplementation(() => 'clipboard-error');
    try {
      await act(async () => { root.render(<MarkdownRichContent content={'```text\nexample\n```'} />); });
      const button = container.querySelector('button')!;
      await act(async () => { button.click(); });
      expect(copy).toHaveBeenCalledWith('example');
      expect(button.textContent).not.toContain('Copied');
      await act(async () => { rejectCopy(new Error('clipboard unavailable')); });
      expect(button.textContent).not.toContain('Copied');
      expect(error).toHaveBeenCalledTimes(1);
      await act(async () => { button.click(); });
      expect(button.textContent).not.toContain('Copied');
      await act(async () => { resolveCopy(); });
      expect(button.textContent).toContain('Copied');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      copy.mockRestore();
      error.mockRestore();
    }
  });
});

describe('provider error notices', () => {
  it('keeps diagnostics out of the initial rendered message', () => {
    const presentation = resolveChatErrorPresentation(Object.assign(new Error('Request failed: 503'), {
      providerError: true, kind: 'provider_overloaded', status: 503, retryable: true,
      providerRawBodyExcerpt: 'private diagnostic body',
    }));
    const markup = renderToStaticMarkup(<MarkdownRichContent content={buildProviderErrorTranscriptMarkdown(presentation)} />);
    expect(markup).toContain('The model could not complete this request.');
    expect(markup).toContain('Try again in a moment.');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('private diagnostic body');
  });

  it('opens and closes the retained diagnostics on request', async () => {
    const presentation = resolveChatErrorPresentation(Object.assign(new Error('Request failed: 503'), {
      providerError: true, kind: 'provider_overloaded', status: 503, retryable: true,
      providerRawBodyExcerpt: 'synthetic diagnostic body',
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<MarkdownRichContent content={buildProviderErrorTranscriptMarkdown(presentation)} />); });
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
      expect(container.textContent).not.toContain('synthetic diagnostic body');
      await act(async () => { trigger.click(); });
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('synthetic diagnostic body');
      await act(async () => { trigger.click(); });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('synthetic diagnostic body');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('renders malformed structured blocks as code instead of hiding them', () => {
    const markup = renderToStaticMarkup(<MarkdownRichContent content={'```macro-provider-error\ninvalid payload\n```'} />);
    expect(markup).toContain('invalid payload');
    expect(markup).not.toContain('The model could not complete this request.');
  });
});
