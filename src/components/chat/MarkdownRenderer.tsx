import React, { Suspense, lazy, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import type { ToolTrace } from '../../types';

const MarkdownRichContent = lazy(() => import('./MarkdownRichContent'));

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

const PlainMarkdownFallback: React.FC<{ content: string }> = ({ content }) => (
  <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
    {content}
  </div>
);

const ThinkingBlock: React.FC<{ content: string; blockKey: number; children?: React.ReactNode }> = ({
  content,
  blockKey: _blockKey,
  children,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="my-3 rounded-lg border border-primary/20 bg-primary/5 overflow-hidden">
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
  let normalized = content.replace(
    /<tool_call>\s*([a-zA-Z0-9_-]+)\s*([\s\S]*?)<\/tool_call>/gi,
    (_full, toolName: string, body: string) => {
      if (body.trim().startsWith('{')) return _full;

      const argValueMatch = body.match(/<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/i);
      const detail = argValueMatch?.[1]?.trim();
      return detail ? `\n[TOOL] ${toolName} ("${detail}")\n` : `\n[TOOL] ${toolName}\n`;
    }
  );

  normalized = normalized.replace(
    /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi,
    (_full, jsonBody: string) => {
      try {
        const parsed = JSON.parse(jsonBody);
        if (parsed.name) {
          const detail = parsed.arguments?.title || parsed.arguments?.query || parsed.arguments?.path || '';
          return detail ? `\n[TOOL] ${parsed.name} ("${detail}")\n` : `\n[TOOL] ${parsed.name}\n`;
        }
      } catch {
        // Ignore malformed local model output.
      }
      return '\n[TOOL] unknown\n';
    }
  );

  return normalized;
};

const MarkdownRendererBase: React.FC<MarkdownRendererProps> = ({
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

  return (
    <div className={cn('markdown-content', className)}>
      {segments.map((segment, index) => {
        if (segment.type === 'thinking') {
          return (
            <ThinkingBlock key={`thinking-${index}`} content={segment.content} blockKey={index}>
              <Suspense fallback={<PlainMarkdownFallback content={segment.content} />}>
                <MarkdownRichContent content={segment.content} />
              </Suspense>
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
          <Suspense key={`text-${index}`} fallback={<PlainMarkdownFallback content={segment.content} />}>
            <MarkdownRichContent content={segment.content} />
          </Suspense>
        );
      })}
    </div>
  );
};

export const MarkdownRenderer = React.memo(
  MarkdownRendererBase,
  (prev, next) =>
    prev.content === next.content &&
    prev.className === next.className &&
    prev.isStreaming === next.isStreaming &&
    prev.toolTraces === next.toolTraces
);

export default MarkdownRenderer;
