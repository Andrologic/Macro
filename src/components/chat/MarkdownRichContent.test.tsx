import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let importCounter = 0;
let markdownRichContentModule: typeof import('./MarkdownRichContent');

beforeEach(async () => {
  mock.restore();
  importCounter += 1;
  markdownRichContentModule = await import(`./MarkdownRichContent.tsx?test=${importCounter}`);
});

describe('normalizeLatexBracketMath', () => {
  it('returns the original string when no latex bracket delimiters are present', () => {
    const content = 'No math here, only regular markdown.';

    expect(markdownRichContentModule.normalizeLatexBracketMath(content)).toBe(content);
  });

  it('converts inline latex paren math to remark-math delimiters', () => {
    expect(markdownRichContentModule.normalizeLatexBracketMath(String.raw`\(R^2\)`)).toBe('$R^2$');
  });

  it('converts display latex bracket math to remark-math delimiters', () => {
    expect(markdownRichContentModule.normalizeLatexBracketMath(String.raw`\[ R^2 = 0{,}47 \]`)).toBe('$$ R^2 = 0{,}47 $$');
  });

  it('converts multiline display math', () => {
    const input = `\\[
R^2 = 0{,}47
\\]`;

    expect(markdownRichContentModule.normalizeLatexBracketMath(input)).toBe(`$$
R^2 = 0{,}47
$$`);
  });

  it('keeps existing dollar-delimited math unchanged', () => {
    const content = '$R^2$ and $$\nR^2 = 0{,}47\n$$';

    expect(markdownRichContentModule.normalizeLatexBracketMath(content)).toBe(content);
  });

  it('does not convert delimiters inside inline code', () => {
    const content = 'Keep \\(\\alpha\\), but not `\\(R^2\\)`.';

    expect(markdownRichContentModule.normalizeLatexBracketMath(content)).toBe('Keep $\\alpha$, but not `\\(R^2\\)`.');
  });

  it('does not convert delimiters inside fenced code blocks', () => {
    const content = [
      'Before \\(x\\)',
      '```md',
      '\\[R^2\\]',
      '```',
      'After \\(y\\)',
    ].join('\n');

    expect(markdownRichContentModule.normalizeLatexBracketMath(content)).toBe([
      'Before $x$',
      '```md',
      '\\[R^2\\]',
      '```',
      'After $y$',
    ].join('\n'));
  });

  it('leaves unmatched delimiters unchanged', () => {
    const content = String.raw`Open \(R^2 and \[value`;

    expect(markdownRichContentModule.normalizeLatexBracketMath(content)).toBe(content);
  });
});

describe('MarkdownRichContent math rendering', () => {
  it('renders latex bracket display math with KaTeX instead of visible markdown brackets', () => {
    const { MarkdownRichContent } = markdownRichContentModule;
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
    const { MarkdownRichContent } = markdownRichContentModule;
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
    const { MarkdownRichContent } = markdownRichContentModule;
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
    const { MarkdownRichContent, isMarkdownVideo } = markdownRichContentModule;
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'![video: Feature demo](/release-notes/demo)'} />
    );

    expect(isMarkdownVideo('/release-notes/demo', 'video: Feature demo')).toBe(true);
    expect(markup).toContain('<video');
    expect(markup).toContain('aria-label="Feature demo"');
  });
});

describe('MarkdownRichContent context references', () => {
  it('renders inline skill references as chips inside normal markdown text', () => {
    const { MarkdownRichContent } = markdownRichContentModule;
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
    const { MarkdownRichContent } = markdownRichContentModule;
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'Sources: [source: product brief]'} />
    );

    expect(markup).toContain('data-context-reference-kind="source"');
    expect(markup).toContain('data-context-reference-surface="message"');
    expect(markup).not.toContain('[source: product brief]');
  });

  it('renders context reference chips in markdown table cells', () => {
    const { MarkdownRichContent } = markdownRichContentModule;
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

  it('does not render context reference chips inside inline code', () => {
    const { MarkdownRichContent } = markdownRichContentModule;
    const markup = renderToStaticMarkup(
      <MarkdownRichContent content={'Keep `[skill: test-skill]` literal'} />
    );

    expect(markup).toContain('[skill: test-skill]');
    expect(markup).not.toContain('data-context-reference-kind="skill"');
  });
});
