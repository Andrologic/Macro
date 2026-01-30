import React, { useMemo, createElement, useState } from 'react';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

/**
 * Thinking Block Component - VS Code style collapsible block
 */
const ThinkingBlock: React.FC<{ content: string; blockKey: number }> = ({ content, blockKey: _blockKey }) => {
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
            {content}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Simple Markdown Renderer
 * Handles basic markdown formatting without external dependencies
 * Can be enhanced with react-markdown + rehype-highlight later
 */
export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className,
}) => {
  const renderedContent = useMemo(() => {
    return parseMarkdown(content);
  }, [content]);

  return (
    <div className={cn('markdown-content', className)}>
      {renderedContent}
    </div>
  );
};

interface ParsedBlock {
  type: 'paragraph' | 'code' | 'heading' | 'list' | 'blockquote' | 'thinking';
  content: string;
  language?: string;
  level?: number;
}

function splitThinkBlocks(content: string): Array<{ type: 'text' | 'thinking'; content: string }> {
  const blocks: Array<{ type: 'text' | 'thinking'; content: string }> = [];
  let remaining = content;

  // Regex for tags - handle variations
  const openRegex = /<\s*(think|thinking)\s*>/i;
  const closeRegex = /<\s*\/\s*(think|thinking)\s*>/i;

  while (remaining.length > 0) {
    const openMatch = remaining.match(openRegex);
    const closeMatch = remaining.match(closeRegex);

    // Case 1: No tags found
    if (!openMatch && !closeMatch) {
      if (remaining.trim()) {
        blocks.push({ type: 'text', content: remaining });
      }
      break;
    }

    // Case 2: Closing tag appears BEFORE any opening tag (or no opening tag exists)
    // This handles the "missing start tag" scenario common in some streamed responses
    // or when the model output starts directly with thinking content
    if (closeMatch && (!openMatch || closeMatch.index! < openMatch.index!)) {
      const splitIndex = closeMatch.index!;
      const thinkContent = remaining.slice(0, splitIndex).trim();
      
      if (thinkContent) {
        blocks.push({ type: 'thinking', content: thinkContent });
      }
      
      // Advance past the closing tag
      remaining = remaining.slice(splitIndex + closeMatch[0].length);
      continue;
    }

    // Case 3: Opening tag found first (Standard case)
    if (openMatch) {
      // Add text before the opening tag
      if (openMatch.index! > 0) {
        const textBefore = remaining.slice(0, openMatch.index!);
        if (textBefore.trim()) {
          blocks.push({ type: 'text', content: textBefore });
        }
      }

      const contentStart = openMatch.index! + openMatch[0].length;
      const rest = remaining.slice(contentStart);
      
      // Find the matching closing tag in the rest
      const nextClose = rest.match(closeRegex);
      
      if (nextClose) {
        // Closed think block
        const thinkContent = rest.slice(0, nextClose.index!).trim();
        if (thinkContent) {
          blocks.push({ type: 'thinking', content: thinkContent });
        }
        remaining = rest.slice(nextClose.index! + nextClose[0].length);
      } else {
        // Unclosed think block (streaming or end of message)
        const thinkContent = rest.trim();
        if (thinkContent) {
          blocks.push({ type: 'thinking', content: thinkContent });
        }
        break; // Nothing left
      }
    }
  }

  return blocks;
}

function parseMarkdownBlocks(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: 'code',
        content: codeLines.join('\n'),
        language: language || 'text',
      });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        content: headingMatch[2],
        level: headingMatch[1].length,
      });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({
        type: 'blockquote',
        content: quoteLines.join('\n'),
      });
      continue;
    }

    // Unordered list
    if (line.match(/^[-*]\s+/)) {
      const listItems: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/)) {
        listItems.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({
        type: 'list',
        content: listItems.join('\n'),
      });
      continue;
    }

    // Regular paragraph (collect consecutive non-empty lines)
    if (line.trim()) {
      const paragraphLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].startsWith('```') &&
        !lines[i].startsWith('#') &&
        !lines[i].startsWith('> ') &&
        !lines[i].match(/^[-*]\s+/)
      ) {
        paragraphLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: 'paragraph',
        content: paragraphLines.join(' '),
      });
      continue;
    }

    i++;
  }

  return blocks;
}

function parseMarkdown(content: string): React.ReactNode[] {
  const blocks: ParsedBlock[] = [];
  const segments = splitThinkBlocks(content);

  for (const segment of segments) {
    if (segment.type === 'thinking') {
      const trimmed = segment.content.trim();
      if (trimmed) {
        blocks.push({ type: 'thinking', content: trimmed });
      }
    } else {
      blocks.push(...parseMarkdownBlocks(segment.content));
    }
  }

  return blocks.map((block, index) => renderBlock(block, index));
}

function renderBlock(block: ParsedBlock, key: number): React.ReactNode {
  switch (block.type) {
    case 'code':
      return (
        <div key={key} className="relative group my-3">
          <div className="flex items-center justify-between bg-muted/80 px-3 py-1.5 rounded-t-lg border border-b-0 border-border">
            <span className="text-xs text-muted-foreground font-mono">
              {block.language}
            </span>
            <button
              onClick={() => navigator.clipboard.writeText(block.content)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
            >
              <Icon name="copy" size={12} />
              Copy
            </button>
          </div>
          <pre className="bg-muted/50 p-3 rounded-b-lg border border-border overflow-x-auto">
            <code className="text-sm font-mono text-foreground whitespace-pre">
              {block.content}
            </code>
          </pre>
        </div>
      );

    case 'heading': {
      const HeadingTag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      const sizeClasses: Record<number, string> = {
        1: 'text-xl font-bold',
        2: 'text-lg font-semibold',
        3: 'text-base font-semibold',
        4: 'text-sm font-semibold',
        5: 'text-sm font-medium',
        6: 'text-xs font-medium',
      };
      return createElement(
        HeadingTag,
        {
          key,
          className: cn('text-foreground mt-4 mb-2', sizeClasses[block.level || 1]),
        },
        renderInline(block.content)
      );
    }

    case 'blockquote':
      return (
        <blockquote
          key={key}
          className="border-l-2 border-primary/50 pl-3 my-2 text-muted-foreground italic"
        >
          {renderInline(block.content)}
        </blockquote>
      );

    case 'list':
      return (
        <ul key={key} className="list-disc list-inside my-2 space-y-1">
          {block.content.split('\n').map((item, i) => (
            <li key={i} className="text-foreground">
              {renderInline(item)}
            </li>
          ))}
        </ul>
      );

    case 'thinking':
      return <ThinkingBlock key={key} content={block.content} blockKey={key} />;

    case 'paragraph':
    default:
      return (
        <p key={key} className="text-foreground my-2 leading-relaxed">
          {renderInline(block.content)}
        </p>
      );
  }
}

function renderInline(text: string): React.ReactNode {
  // Simple regex-based inline formatting
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  // Combined regex for inline code, bold, italic, and links
  const inlineRegex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const [fullMatch] = match;

    if (fullMatch.startsWith('`')) {
      // Inline code
      parts.push(
        <code
          key={key++}
          className="px-1.5 py-0.5 bg-muted rounded text-sm font-mono text-primary"
        >
          {fullMatch.slice(1, -1)}
        </code>
      );
    } else if (fullMatch.startsWith('**')) {
      // Bold
      parts.push(
        <strong key={key++} className="font-semibold">
          {fullMatch.slice(2, -2)}
        </strong>
      );
    } else if (fullMatch.startsWith('*')) {
      // Italic
      parts.push(
        <em key={key++} className="italic">
          {fullMatch.slice(1, -1)}
        </em>
      );
    } else if (fullMatch.startsWith('[')) {
      // Link
      const linkMatch = fullMatch.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        parts.push(
          <a
            key={key++}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            {linkMatch[1]}
          </a>
        );
      }
    }

    lastIndex = match.index + fullMatch.length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

/**
 * Estimate token count (rough approximation)
 * ~4 characters per token for English text
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Simple heuristic: ~4 chars per token on average
  return Math.ceil(text.length / 4);
}

/**
 * Format token count for display
 */
export function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}
