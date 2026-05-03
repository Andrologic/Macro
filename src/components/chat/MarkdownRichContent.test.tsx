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
