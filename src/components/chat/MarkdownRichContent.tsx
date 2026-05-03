import React, { Suspense, lazy, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import rust from 'highlight.js/lib/languages/rust';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

const MermaidRenderer = lazy(() => import('./MermaidRenderer'));

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  tsx: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  htm: 'xml',
  psql: 'sql',
  mysql: 'sql',
};

let blockKeySeed = 0;

const MATH_DELIMITER_CLOSE: Record<string, string> = {
  '\\(': '\\)',
  '\\[': '\\]',
};

const MATH_DELIMITER_MARKDOWN: Record<string, string> = {
  '\\(': '$',
  '\\[': '$$',
};

const hasLatexBracketMathDelimiters = (content: string): boolean =>
  content.includes('\\(') ||
  content.includes('\\)') ||
  content.includes('\\[') ||
  content.includes('\\]');

const countRun = (content: string, start: number, character: string): number => {
  let cursor = start;
  while (cursor < content.length && content[cursor] === character) {
    cursor += 1;
  }
  return cursor - start;
};

const isMarkdownFenceStart = (content: string, start: number): { marker: string; length: number } | null => {
  let cursor = start;
  let leadingSpaces = 0;

  while (cursor < content.length && content[cursor] === ' ' && leadingSpaces < 4) {
    cursor += 1;
    leadingSpaces += 1;
  }

  if (leadingSpaces > 3) return null;

  const marker = content[cursor];
  if (marker !== '`' && marker !== '~') return null;

  const length = countRun(content, cursor, marker);
  return length >= 3 ? { marker, length } : null;
};

const startsWithClosingFence = (
  content: string,
  start: number,
  marker: string,
  length: number
): boolean => {
  const candidate = isMarkdownFenceStart(content, start);
  return !!candidate && candidate.marker === marker && candidate.length >= length;
};

const findLatexMathClose = (
  content: string,
  start: number,
  closeDelimiter: string
): number => {
  let cursor = start;
  let lineStart = start === 0 || content[start - 1] === '\n';

  while (cursor < content.length) {
    if (lineStart && isMarkdownFenceStart(content, cursor)) {
      return -1;
    }

    const current = content[cursor];
    if (current === '`') {
      return -1;
    }

    if (content.startsWith(closeDelimiter, cursor)) {
      return cursor;
    }

    cursor += 1;
    lineStart = current === '\n';
  }

  return -1;
};

export const normalizeLatexBracketMath = (content: string): string => {
  if (!hasLatexBracketMathDelimiters(content)) return content;

  let output = '';
  let cursor = 0;
  let lineStart = true;
  let inlineCodeTicks = 0;
  let fenceMarker: string | null = null;
  let fenceLength = 0;
  let fenceClosesAtLineEnd = false;
  let changed = false;

  while (cursor < content.length) {
    if (fenceMarker) {
      const closesFence = lineStart && startsWithClosingFence(content, cursor, fenceMarker, fenceLength);
      if (closesFence) {
        fenceClosesAtLineEnd = true;
      }
      const current = content[cursor];
      output += current;
      cursor += 1;
      lineStart = current === '\n';
      if (fenceClosesAtLineEnd && (lineStart || cursor >= content.length)) {
        fenceMarker = null;
        fenceLength = 0;
        fenceClosesAtLineEnd = false;
      }
      continue;
    }

    if (inlineCodeTicks > 0) {
      if (content[cursor] === '`') {
        const ticks = countRun(content, cursor, '`');
        output += content.slice(cursor, cursor + ticks);
        cursor += ticks;
        if (ticks === inlineCodeTicks) {
          inlineCodeTicks = 0;
        }
        lineStart = false;
        continue;
      }

      const current = content[cursor];
      output += current;
      cursor += 1;
      lineStart = current === '\n';
      continue;
    }

    if (lineStart) {
      const fence = isMarkdownFenceStart(content, cursor);
      if (fence) {
        fenceMarker = fence.marker;
        fenceLength = fence.length;
        fenceClosesAtLineEnd = false;
        const currentFenceCharacter = content[cursor];
        output += currentFenceCharacter;
        cursor += 1;
        lineStart = currentFenceCharacter === '\n';
        continue;
      }
    }

    const current = content[cursor];
    if (current === '`') {
      const ticks = countRun(content, cursor, '`');
      output += content.slice(cursor, cursor + ticks);
      cursor += ticks;
      inlineCodeTicks = ticks;
      lineStart = false;
      continue;
    }

    const openDelimiter = content.startsWith('\\[', cursor)
      ? '\\['
      : content.startsWith('\\(', cursor)
        ? '\\('
        : null;

    if (openDelimiter) {
      const closeDelimiter = MATH_DELIMITER_CLOSE[openDelimiter];
      const closeIndex = findLatexMathClose(content, cursor + openDelimiter.length, closeDelimiter);

      if (closeIndex !== -1) {
        const markdownDelimiter = MATH_DELIMITER_MARKDOWN[openDelimiter];
        output += markdownDelimiter;
        output += content.slice(cursor + openDelimiter.length, closeIndex);
        output += markdownDelimiter;
        cursor = closeIndex + closeDelimiter.length;
        changed = true;
        lineStart = false;
        continue;
      }
    }

    output += current;
    cursor += 1;
    lineStart = current === '\n';
  }

  return changed ? output : content;
};

const omitMarkdownDomProps = <T extends { node?: unknown; ref?: unknown }>(
  props: T
): Omit<T, 'node' | 'ref'> => {
  const { node: _node, ref: _ref, ...domProps } = props;
  return domProps;
};

const getTextFromChildren = (children: React.ReactNode): string => {
  if (children === null || children === undefined) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(getTextFromChildren).join('');
  if (React.isValidElement(children)) return getTextFromChildren((children.props as { children?: React.ReactNode }).children);
  return '';
};

const MermaidFallback: React.FC = () => (
  <div className="my-3 rounded-lg border border-border bg-card/40 p-4">
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div className="h-3 w-3 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
      Rendering diagram...
    </div>
  </div>
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

interface CodeBlockProps {
  content: string;
  language?: string;
  blockKey: number;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ content, language = 'text', blockKey }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const normalizedLang = useMemo(() => {
    const lang = language.toLowerCase().trim();
    return LANGUAGE_ALIASES[lang] || lang || 'text';
  }, [language]);

  const highlighted = useMemo(() => {
    if (normalizedLang === 'text' || !hljs.getLanguage(normalizedLang)) {
      try {
        return hljs.highlightAuto(content).value;
      } catch {
        return escapeHtml(content);
      }
    }

    try {
      return hljs.highlight(content, { language: normalizedLang }).value;
    } catch {
      return escapeHtml(content);
    }
  }, [content, normalizedLang]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const displayLang = language && language !== 'text' ? language : 'plaintext';

  return (
    <div key={blockKey} className="relative group my-3">
      <div className="flex items-center justify-between bg-muted/80 px-3 py-1.5 rounded-t-lg border border-b-0 border-border">
        <span className="text-xs text-muted-foreground font-mono capitalize">
          {displayLang}
        </span>
        <button
          onClick={handleCopy}
          className={cn(
            'flex items-center gap-1.5 text-xs transition-all duration-200',
            copied
              ? 'text-green-500'
              : 'text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100'
          )}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? t('chat.copied', 'Copied') : t('chat.copyCode', 'Copy code')}
        </button>
      </div>

      <pre className="bg-[#1e1e1e] p-3 rounded-b-lg border border-border overflow-x-auto">
        <code
          className="text-sm font-mono whitespace-pre hljs-code"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
};

export interface MarkdownRichContentProps {
  content: string;
}

const MarkdownRichContentBase: React.FC<MarkdownRichContentProps> = ({ content }) => {
  const normalizedContent = useMemo(() => normalizeLatexBracketMath(content), [content]);
  const components = useMemo<Components>(() => ({
    a: ({ href, children, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <a
          {...domProps}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {children}
        </a>
      );
    },
    h1: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <h1 {...domProps} className={cn('text-xl font-bold mt-4 mb-2', headingClassName)} />;
    },
    h2: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <h2 {...domProps} className={cn('text-lg font-semibold mt-4 mb-2', headingClassName)} />;
    },
    h3: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <h3 {...domProps} className={cn('text-base font-semibold mt-3 mb-2', headingClassName)} />;
    },
    h4: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <h4 {...domProps} className={cn('text-sm font-semibold mt-3 mb-2', headingClassName)} />;
    },
    h5: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <h5 {...domProps} className={cn('text-sm font-medium mt-3 mb-2', headingClassName)} />;
    },
    h6: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <h6 {...domProps} className={cn('text-xs font-medium mt-3 mb-2', headingClassName)} />;
    },
    blockquote: ({ className: blockquoteClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <blockquote
          {...domProps}
          className={cn('border-l-2 border-primary/50 pl-3 my-2 text-muted-foreground italic', blockquoteClassName)}
        />
      );
    },
    code: ({ className, children, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      const blockKeyRef = useRef(++blockKeySeed);
      const languageMatch = /language-([^\s]+)/i.exec(className || '');
      const language = languageMatch?.[1] || '';
      const codeText = getTextFromChildren(children).replace(/\n$/, '');

      if (language.toLowerCase() === 'mermaid' || language.toLowerCase() === 'mmd') {
        return (
          <Suspense fallback={<MermaidFallback />}>
            <MermaidRenderer code={codeText} blockKey={blockKeyRef.current} />
          </Suspense>
        );
      }

      if (language.toLowerCase() === 'thinking') {
        return <div className="whitespace-pre-wrap text-sm text-muted-foreground">{codeText}</div>;
      }

      const isBlock = !!language || codeText.includes('\n');
      if (isBlock) {
        return (
          <CodeBlock
            content={codeText}
            language={language || 'text'}
            blockKey={blockKeyRef.current}
          />
        );
      }

      return (
        <code
          {...domProps}
          className={cn(
            'px-1.5 py-0.5 mx-0.5 bg-muted border border-border/50 rounded-md text-[0.875em] font-mono text-primary font-medium',
            className
          )}
        >
          {children}
        </code>
      );
    },
    pre: (props) => <>{props.children}</>,
    ul: ({ className: listClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <ul {...domProps} className={cn('list-disc list-inside my-2 space-y-1', listClassName)} />;
    },
    ol: ({ className: listClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <ol {...domProps} className={cn('list-decimal list-inside my-2 space-y-1', listClassName)} />;
    },
    li: ({ className: itemClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <li {...domProps} className={cn('text-foreground', itemClassName)} />;
    },
    table: ({ className: tableClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <table {...domProps} className={cn('w-full text-sm border border-border rounded-lg overflow-hidden', tableClassName)} />;
    },
    thead: ({ className: sectionClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <thead {...domProps} className={cn('bg-muted/40', sectionClassName)} />;
    },
    tbody: ({ className: sectionClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <tbody {...domProps} className={cn('divide-y divide-border', sectionClassName)} />;
    },
    tr: ({ className: rowClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <tr {...domProps} className={cn('divide-x divide-border', rowClassName)} />;
    },
    th: ({ className: cellClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <th {...domProps} className={cn('text-left font-semibold px-3 py-2', cellClassName)} />;
    },
    td: ({ className: cellClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return <td {...domProps} className={cn('px-3 py-2 align-top', cellClassName)} />;
    },
    input: ({ type, className: inputClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      if (type === 'checkbox') {
        return (
          <input
            {...domProps}
            type="checkbox"
            disabled
            className={cn('mr-2 align-middle accent-primary', inputClassName)}
          />
        );
      }
      return <input {...domProps} type={type} className={inputClassName} />;
    },
  }), []);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      skipHtml
      components={components}
    >
      {normalizedContent}
    </ReactMarkdown>
  );
};

export const MarkdownRichContent = React.memo(
  MarkdownRichContentBase,
  (prev, next) => prev.content === next.content
);

export default MarkdownRichContent;
