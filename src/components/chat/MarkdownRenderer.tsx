import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { MermaidRenderer } from './MermaidRenderer';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { ToolTrace } from '../../types';

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
  isStreaming?: boolean;
  toolTraces?: ToolTrace[];
}

type RenderSegment =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool'; toolName: string; detail?: string; status: 'running' | 'done' };

const omitMarkdownDomProps = <T extends { node?: unknown; ref?: unknown }>(
  props: T
): Omit<T, 'node' | 'ref'> => {
  const { node: _node, ref: _ref, ...domProps } = props;
  return domProps;
};

// =============================================================================
// THINKING BLOCK COMPONENT
// =============================================================================

const ThinkingBlock: React.FC<{ content: string; blockKey: number; children?: React.ReactNode }> = ({
  content,
  blockKey: _blockKey,
  children,
}) => {
  const { t } = useTranslation();
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
          {t('chat.thinking', 'Thinking...')}
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

const ToolCallBlock: React.FC<{ toolName: string; detail?: string; status: 'running' | 'done' }> = ({
  toolName,
  detail,
  status,
}) => {
  const { t } = useTranslation();
  return (
    <div className="my-2 rounded-lg border border-border bg-card/60 px-2.5 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-5 h-5 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <Icon name="tool" size={11} className="text-primary" />
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{t('chat.tool', 'Tool')}</span>
        <span className="text-xs font-medium text-foreground truncate">{toolName}</span>
        {detail && (
          <span className="text-xs text-muted-foreground/80 font-mono truncate">
            {detail}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-primary/80 bg-primary/10 rounded px-1.5 py-0.5 shrink-0">
          <span className={cn('w-1.5 h-1.5 rounded-full bg-primary', status === 'running' && 'animate-pulse')} />
          {status}
        </span>
      </div>
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
  const { t } = useTranslation();
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
          {copied ? t('chat.copied', 'Copied') : t('chat.copyCode', 'Copy code')}
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

const splitStructuredToolTraceBlocks = (content: string, toolTraces: ToolTrace[]): RenderSegment[] => {
  const segments: RenderSegment[] = [];
  const orderedToolTraces = [...toolTraces].sort((left, right) => {
    const leftOffset = typeof left.visible_offset === 'number' ? left.visible_offset : content.length;
    const rightOffset = typeof right.visible_offset === 'number' ? right.visible_offset : content.length;
    if (leftOffset !== rightOffset) return leftOffset - rightOffset;
    return left.tool_call_id.localeCompare(right.tool_call_id);
  });

  let cursor = 0;
  for (const toolTrace of orderedToolTraces) {
    const requestedOffset =
      typeof toolTrace.visible_offset === 'number' ? toolTrace.visible_offset : content.length;
    const clampedOffset = Math.max(cursor, Math.min(content.length, requestedOffset));
    const textBefore = content.slice(cursor, clampedOffset);
    if (textBefore) {
      segments.push({ type: 'text', content: textBefore });
    }
    segments.push({
      type: 'tool',
      toolName: toolTrace.tool_name,
      detail: toolTrace.detail,
      status: toolTrace.status,
    });
    cursor = clampedOffset;
  }

  const remaining = content.slice(cursor);
  if (remaining) {
    segments.push({ type: 'text', content: remaining });
  }

  return segments;
};

const splitToolBlocks = (content: string, isStreaming: boolean): RenderSegment[] => {
  const segments: RenderSegment[] = [];
  const lines = content.split('\n');
  const textBuffer: string[] = [];
  const toolStartRegex = /^(?:\[\s*TOOL\s*\]|🔧\s*\*\*Tool:\*\*)\s*([a-zA-Z0-9_-]+)(?:\s*\((.+?)\))?\s*$/i;
  const toolDoneRegex = /^\[\s*TOOL_DONE\s*\]\s*([a-zA-Z0-9_-]+)(?:\s*\((.+?)\))?\s*$/i;
  const pendingToolIndexes: number[] = [];

  const flushText = () => {
    if (textBuffer.length === 0) return;
    const text = textBuffer.join('\n');
    if (text.trim()) {
      segments.push({ type: 'text', content: text });
    }
    textBuffer.length = 0;
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    const startMatch = trimmedLine.match(toolStartRegex);
    if (startMatch) {
      flushText();
      const nextToolSegment: RenderSegment = {
        type: 'tool',
        toolName: startMatch[1],
        detail: startMatch[2],
        status: isStreaming ? 'running' : 'done',
      };
      const previous = segments[segments.length - 1];
      const sameAsPrevious =
        previous?.type === 'tool' &&
        previous.toolName === nextToolSegment.toolName &&
        (previous.detail || '').normalize('NFC') === (nextToolSegment.detail || '').normalize('NFC') &&
        previous.status === nextToolSegment.status;
      if (!sameAsPrevious) {
        segments.push(nextToolSegment);
        if (nextToolSegment.status === 'running') {
          pendingToolIndexes.push(segments.length - 1);
        }
      }
      continue;
    }

    const doneMatch = trimmedLine.match(toolDoneRegex);
    if (doneMatch) {
      flushText();
      const doneToolName = doneMatch[1];
      const doneDetail = doneMatch[2];
      const pendingIndex = pendingToolIndexes.findIndex((segmentIndex) => {
        const segment = segments[segmentIndex];
        if (!segment || segment.type !== 'tool') return false;
        if (segment.toolName !== doneToolName || segment.status !== 'running') return false;
        if (!doneDetail) return true;
        return (segment.detail || '').normalize('NFC') === doneDetail.normalize('NFC');
      });

      if (pendingIndex !== -1) {
        const segmentIndex = pendingToolIndexes[pendingIndex];
        const segment = segments[segmentIndex];
        if (segment && segment.type === 'tool') {
          segment.status = 'done';
        }
        pendingToolIndexes.splice(pendingIndex, 1);
      }
      continue;
    }

    textBuffer.push(line);
  }

  flushText();
  return segments;
};

const normalizeToolCallMarkup = (content: string): string => {
  // 1. Handle the old format: <tool_call> toolName <arg_value>...
  let normalized = content.replace(
    /<tool_call>\s*([a-zA-Z0-9_-]+)\s*([\s\S]*?)<\/tool_call>/gi,
    (_full, toolName: string, body: string) => {
      // If it looks like JSON, skip it for the next regex
      if (body.trim().startsWith('{')) return _full;

      const argValueMatch = body.match(/<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/i);
      const detail = argValueMatch?.[1]?.trim();
      return detail ? `\n[TOOL] ${toolName} ("${detail}")\n` : `\n[TOOL] ${toolName}\n`;
    }
  );

  // 2. Handle the standard JSON format used by local models: <tool_call> {"name": "...", "arguments": {...}} </tool_call>
  normalized = normalized.replace(
    /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi,
    (_full, jsonBody: string) => {
      try {
        const parsed = JSON.parse(jsonBody);
        if (parsed.name) {
          // You could stringify specific arguments you want to display, or just show the tool name
          const detail = parsed.arguments?.title || parsed.arguments?.query || parsed.arguments?.path || '';
          return detail ? `\n[TOOL] ${parsed.name} ("${detail}")\n` : `\n[TOOL] ${parsed.name}\n`;
        }
      } catch (e) {
        // Ignore JSON parse errors and just hide it or show a generic fallback
      }
      return `\n[TOOL] unknown\n`;
    }
  );

  return normalized;
};

// =============================================================================
// MAIN MARKDOWN RENDERER
// =============================================================================

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className,
  isStreaming = false,
  toolTraces,
}) => {
  const structuredToolTraces = toolTraces && toolTraces.length > 0 ? toolTraces : null;
  const segments = useMemo<RenderSegment[]>(() => {
    const expanded: RenderSegment[] = [];

    if (structuredToolTraces) {
      const anchoredSegments = splitStructuredToolTraceBlocks(content, structuredToolTraces);
      for (const segment of anchoredSegments) {
        if (segment.type === 'tool') {
          expanded.push(segment);
          continue;
        }
        for (const thinkSegment of splitThinkBlocks(segment.content)) {
          expanded.push(thinkSegment);
        }
      }
      return expanded;
    }

    const normalizedContent = normalizeToolCallMarkup(content);
    const thinkSegments = splitThinkBlocks(normalizedContent);
    for (const segment of thinkSegments) {
      if (segment.type === 'thinking') {
        expanded.push(segment);
        continue;
      }
      expanded.push(...splitToolBlocks(segment.content, isStreaming));
    }

    return expanded;
  }, [content, isStreaming, structuredToolTraces]);

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
      return (
        <h1 {...domProps} className={cn('text-xl font-bold mt-4 mb-2', headingClassName)} />
      );
    },
    h2: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <h2 {...domProps} className={cn('text-lg font-semibold mt-4 mb-2', headingClassName)} />
      );
    },
    h3: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <h3 {...domProps} className={cn('text-base font-semibold mt-3 mb-2', headingClassName)} />
      );
    },
    h4: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <h4 {...domProps} className={cn('text-sm font-semibold mt-3 mb-2', headingClassName)} />
      );
    },
    h5: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <h5 {...domProps} className={cn('text-sm font-medium mt-3 mb-2', headingClassName)} />
      );
    },
    h6: ({ className: headingClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <h6 {...domProps} className={cn('text-xs font-medium mt-3 mb-2', headingClassName)} />
      );
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
      return (
        <ul {...domProps} className={cn('list-disc list-inside my-2 space-y-1', listClassName)} />
      );
    },
    ol: ({ className: listClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <ol {...domProps} className={cn('list-decimal list-inside my-2 space-y-1', listClassName)} />
      );
    },
    li: ({ className: itemClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <li {...domProps} className={cn('text-foreground', itemClassName)} />
      );
    },
    table: ({ className: tableClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <table {...domProps} className={cn('w-full text-sm border border-border rounded-lg overflow-hidden', tableClassName)} />
      );
    },
    thead: ({ className: sectionClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <thead {...domProps} className={cn('bg-muted/40', sectionClassName)} />
      );
    },
    tbody: ({ className: sectionClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <tbody {...domProps} className={cn('divide-y divide-border', sectionClassName)} />
      );
    },
    tr: ({ className: rowClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <tr {...domProps} className={cn('divide-x divide-border', rowClassName)} />
      );
    },
    th: ({ className: cellClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <th {...domProps} className={cn('text-left font-semibold px-3 py-2', cellClassName)} />
      );
    },
    td: ({ className: cellClassName, ...props }) => {
      const domProps = omitMarkdownDomProps(props);
      return (
        <td {...domProps} className={cn('px-3 py-2 align-top', cellClassName)} />
      );
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

        if (segment.type === 'tool') {
          return (
            <ToolCallBlock
              key={`tool-${index}`}
              toolName={segment.toolName}
              detail={segment.detail}
              status={segment.status}
            />
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

