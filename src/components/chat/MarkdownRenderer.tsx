import React, { useCallback, useMemo, useRef, useState } from 'react';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { MermaidRenderer } from './MermaidRenderer';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// =============================================================================
// HIGHLIGHT.JS - SYNTAX HIGHLIGHTING
// =============================================================================

import hljs from 'highlight.js/lib/core';

// Import common languages
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

// Register languages
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

// Language alias mapping
const LANGUAGE_ALIASES: Record<string, string> = {
  'ts': 'typescript',
  'js': 'javascript',
  'jsx': 'javascript',
  'tsx': 'typescript',
  'py': 'python',
  'sh': 'bash',
  'shell': 'bash',
  'zsh': 'bash',
  'yml': 'yaml',
  'md': 'markdown',
  'htm': 'xml',
  'psql': 'sql',
  'mysql': 'sql',
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

// =============================================================================
// THINKING BLOCK COMPONENT
// =============================================================================

const ThinkingBlock: React.FC<{ content: string; blockKey: number; children?: React.ReactNode }> = ({
  content,
  blockKey: _blockKey,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="my-3 rounded-lg border border-primary/20 bg-primary/5 overflow-hidden">
      {/* Header - always visible */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-primary/10 transition-colors"
      >
        <Icon 
          name={isOpen ? 'chevron-down' : 'chevron-right'} 
          size={14} 
          className="text-primary/80 shrink-0" 
        />
        <span className="text-xs font-medium text-primary/80">
          Thinking...
        </span>
        {!isOpen && (
          <span className="text-xs text-muted-foreground/60 truncate flex-1">
            {content.slice(0, 80)}{content.length > 80 ? '...' : ''}
          </span>
        )}
      </button>
      
      {/* Content - collapsible */}
      {isOpen && (
        <div className="px-3 pb-3 pt-1 border-t border-primary/10">
          <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
            {children ?? content}
          </div>
        </div>
      )}
    </div>
  );
};

// =============================================================================
// CODE BLOCK COMPONENT WITH SYNTAX HIGHLIGHTING
// =============================================================================

interface CodeBlockProps {
  content: string;
  language?: string;
  blockKey: number;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ content, language = 'text', blockKey }) => {
  const [copied, setCopied] = useState(false);

  const normalizedLang = useMemo(() => {
    const lang = language.toLowerCase().trim();
    return LANGUAGE_ALIASES[lang] || lang || 'text';
  }, [language]);

  const highlighted = useMemo(() => {
    if (normalizedLang === 'text' || !hljs.getLanguage(normalizedLang)) {
      // Try auto-detection for unknown languages
      try {
        const result = hljs.highlightAuto(content);
        return result.value;
      } catch {
        return escapeHtml(content);
      }
    }
    try {
      const result = hljs.highlight(content, { language: normalizedLang });
      return result.value;
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
      {/* Header */}
      <div className="flex items-center justify-between bg-muted/80 px-3 py-1.5 rounded-t-lg border border-b-0 border-border">
        <span className="text-xs text-muted-foreground font-mono capitalize">
          {displayLang}
        </span>
        <button
          onClick={handleCopy}
          className={cn(
            "flex items-center gap-1.5 text-xs transition-all duration-200",
            copied 
              ? "text-green-500" 
              : "text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100"
          )}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      
      {/* Code Content */}
      <pre className="bg-[#1e1e1e] p-3 rounded-b-lg border border-border overflow-x-auto">
        <code 
          className="text-sm font-mono whitespace-pre hljs-code"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =============================================================================
// MARKDOWN PIPELINE (REMARK/REHYPE)
// =============================================================================

let blockKeySeed = 0;

const getTextFromChildren = (children: React.ReactNode): string => {
  if (children === null || children === undefined) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(getTextFromChildren).join('');
  if (React.isValidElement(children)) return getTextFromChildren((children.props as any).children);
  return '';
};

const splitThinkBlocks = (content: string): Array<{ type: 'text' | 'thinking'; content: string }> => {
  const blocks: Array<{ type: 'text' | 'thinking'; content: string }> = [];
  let remaining = content;

  const openRegex = /<\s*(think|thinking)\s*>/i;
  const closeRegex = /<\s*\/\s*(think|thinking)\s*>/i;

  while (remaining.length > 0) {
    const openMatch = remaining.match(openRegex);
    const closeMatch = remaining.match(closeRegex);

    if (!openMatch && !closeMatch) {
      if (remaining.trim()) {
        blocks.push({ type: 'text', content: remaining });
      }
      break;
    }

    if (closeMatch && (!openMatch || closeMatch.index! < openMatch.index!)) {
      const splitIndex = closeMatch.index!;
      const thinkContent = remaining.slice(0, splitIndex).trim();

      if (thinkContent) {
        blocks.push({ type: 'thinking', content: thinkContent });
      }

      remaining = remaining.slice(splitIndex + closeMatch[0].length);
      continue;
    }

    if (openMatch) {
      if (openMatch.index! > 0) {
        const textBefore = remaining.slice(0, openMatch.index!);
        if (textBefore.trim()) {
          blocks.push({ type: 'text', content: textBefore });
        }
      }

      const contentStart = openMatch.index! + openMatch[0].length;
      const rest = remaining.slice(contentStart);
      const nextClose = rest.match(closeRegex);

      if (nextClose) {
        const thinkContent = rest.slice(0, nextClose.index!).trim();
        if (thinkContent) {
          blocks.push({ type: 'thinking', content: thinkContent });
        }
        remaining = rest.slice(nextClose.index! + nextClose[0].length);
      } else {
        const thinkContent = rest.trim();
        if (thinkContent) {
          blocks.push({ type: 'thinking', content: thinkContent });
        }
        break;
      }
    }
  }

  return blocks;
};

// =============================================================================
// MAIN MARKDOWN RENDERER
// =============================================================================

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className,
}) => {
  const segments = useMemo(() => splitThinkBlocks(content), [content]);

  const components = useMemo(() => ({
    a: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {children}
      </a>
    ),
    h1: (props: React.ComponentProps<'h1'>) => (
      <h1 {...props} className={cn('text-xl font-bold mt-4 mb-2', props.className)} />
    ),
    h2: (props: React.ComponentProps<'h2'>) => (
      <h2 {...props} className={cn('text-lg font-semibold mt-4 mb-2', props.className)} />
    ),
    h3: (props: React.ComponentProps<'h3'>) => (
      <h3 {...props} className={cn('text-base font-semibold mt-3 mb-2', props.className)} />
    ),
    h4: (props: React.ComponentProps<'h4'>) => (
      <h4 {...props} className={cn('text-sm font-semibold mt-3 mb-2', props.className)} />
    ),
    h5: (props: React.ComponentProps<'h5'>) => (
      <h5 {...props} className={cn('text-sm font-medium mt-3 mb-2', props.className)} />
    ),
    h6: (props: React.ComponentProps<'h6'>) => (
      <h6 {...props} className={cn('text-xs font-medium mt-3 mb-2', props.className)} />
    ),
    blockquote: (props: React.ComponentProps<'blockquote'>) => (
      <blockquote
        {...props}
        className={cn('border-l-2 border-primary/50 pl-3 my-2 text-muted-foreground italic', props.className)}
      />
    ),
    code: ({ className, children, ...props }: React.ComponentProps<'code'>) => {
      const blockKeyRef = useRef(++blockKeySeed);
      const languageMatch = /language-([^\s]+)/i.exec(className || '');
      const language = languageMatch?.[1] || '';
      const codeText = getTextFromChildren(children).replace(/\n$/, '');

      if (language.toLowerCase() === 'mermaid' || language.toLowerCase() === 'mmd') {
        return <MermaidRenderer code={codeText} blockKey={blockKeyRef.current} />;
      }

      if (language.toLowerCase() === 'thinking') {
        return <ThinkingBlock content={codeText} blockKey={blockKeyRef.current} />;
      }

      // In react-markdown v9+, 'inline' prop is no longer passed.
      // We detect blocks by checking if there's a language or if the code contains newlines.
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
          {...props}
          className={cn(
            'px-1.5 py-0.5 mx-0.5 bg-muted border border-border/50 rounded-md text-[0.875em] font-mono text-primary font-medium',
            className
          )}
        >
          {children}
        </code>
      );
    },
    pre: (props: any) => <>{props.children}</>,
    ul: (props: React.ComponentProps<'ul'>) => (
      <ul {...props} className={cn('list-disc list-inside my-2 space-y-1', props.className)} />
    ),
    ol: (props: React.ComponentProps<'ol'>) => (
      <ol {...props} className={cn('list-decimal list-inside my-2 space-y-1', props.className)} />
    ),
    li: (props: React.ComponentProps<'li'>) => (
      <li {...props} className={cn('text-foreground', props.className)} />
    ),
    table: (props: React.ComponentProps<'table'>) => (
      <table {...props} className={cn('w-full text-sm border border-border rounded-lg overflow-hidden', props.className)} />
    ),
    thead: (props: React.ComponentProps<'thead'>) => (
      <thead {...props} className={cn('bg-muted/40', props.className)} />
    ),
    tbody: (props: React.ComponentProps<'tbody'>) => (
      <tbody {...props} className={cn('divide-y divide-border', props.className)} />
    ),
    tr: (props: React.ComponentProps<'tr'>) => (
      <tr {...props} className={cn('divide-x divide-border', props.className)} />
    ),
    th: (props: React.ComponentProps<'th'>) => (
      <th {...props} className={cn('text-left font-semibold px-3 py-2', props.className)} />
    ),
    td: (props: React.ComponentProps<'td'>) => (
      <td {...props} className={cn('px-3 py-2 align-top', props.className)} />
    ),
    input: ({ type, ...props }: React.ComponentProps<'input'>) => {
      if (type === 'checkbox') {
        return (
          <input
            {...props}
            type="checkbox"
            disabled
            className={cn('mr-2 align-middle accent-primary', props.className)}
          />
        );
      }
      return <input {...props} />;
    },
  }), []);

  return (
    <div className={cn('markdown-content', className)}>
      {segments.map((segment, index) => {
        if (segment.type === 'thinking') {
          return (
            <ThinkingBlock key={`thinking-${index}`} content={segment.content} blockKey={index}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                skipHtml
                components={components}
              >
                {segment.content}
              </ReactMarkdown>
            </ThinkingBlock>
          );
        }

        return (
          <ReactMarkdown
            key={`text-${index}`}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            skipHtml
            components={components}
          >
            {segment.content}
          </ReactMarkdown>
        );
      })}
    </div>
  );
};

// =============================================================================
// UTILITY EXPORTS
// =============================================================================

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}
