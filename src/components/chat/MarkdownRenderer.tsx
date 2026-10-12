import React, { Suspense, lazy, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../utils/cn';
import { BUILT_IN_TOOLS } from '../../services/tools/builtInTools';
import { normalizeArchitectToolId } from '../../services/architectToolNames';
import { Icon, type IconName } from '../ui/Icon';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/Accordion';
import type { ToolTrace } from '../../types';
import {
  buildRenderState,
  buildStructuredToolGroups,
  splitLegacyToolBlocks,
  type RenderBlock,
  type ToolRenderTrace,
} from '../../services/markdownRenderProjection';

const MarkdownRichContent = lazy(() => import('./MarkdownRichContent'));

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  toolTraces?: ToolTrace[];
}

const PlainMarkdownFallback: React.FC<{ content: string }> = ({ content }) => (
  <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
    {content}
  </div>
);

const TOOL_TRACE_ICON_BY_NAME = new Map<string, IconName>(
  BUILT_IN_TOOLS.flatMap((tool) => {
    const normalizedId = normalizeArchitectToolId(tool.id);
    return normalizedId === tool.id
      ? [[tool.id, tool.icon]]
      : [
          [tool.id, tool.icon],
          [normalizedId, tool.icon],
        ];
  })
);

const getToolTraceIconName = (toolName: string): IconName => {
  const normalizedToolName = normalizeArchitectToolId(toolName);
  return (
    TOOL_TRACE_ICON_BY_NAME.get(toolName) ??
    TOOL_TRACE_ICON_BY_NAME.get(normalizedToolName) ??
    'tool'
  );
};

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

const ToolTraceRow: React.FC<{ toolName: string; detail?: string; status: ToolTrace['status']; recoveryState?: ToolTrace['recovery_state'] }> = ({
  toolName,
  detail,
  status,
  recoveryState,
}) => {
  const { t } = useTranslation();
  const isRunning = status === 'running' && (!recoveryState || recoveryState === 'live');
  const isPendingApproval = status === 'pending_approval';
  const isDenied = status === 'denied';
  const iconName = getToolTraceIconName(toolName);
  const badgeLabel = recoveryState === 'unknown'
    ? t('chat.toolOutcomeUnknown', 'outcome unknown')
    : recoveryState === 'replayable'
      ? t('chat.toolApprovalCanRetry', 'approval can be requested again')
      : status === 'pending_approval'
      ? t('chat.toolPendingApproval', 'pending approval')
      : status === 'denied'
        ? t('chat.toolDenied', 'denied')
        : status;

  return (
    <div
      data-testid="tool-trace-item"
      data-tool-name={toolName}
      data-tool-status={status}
      data-recovery-state={recoveryState}
      className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-5 h-5 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <Icon name={iconName} size={11} className="text-primary" />
        </div>
        <span className="text-xs font-medium text-foreground truncate">{toolName}</span>
        {detail && (
          <span className="text-xs text-muted-foreground/80 font-mono truncate">
            {detail}
          </span>
        )}
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] shrink-0',
            isDenied
              ? 'bg-destructive/10 text-destructive'
              : isPendingApproval
                ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                : 'bg-primary/10 text-primary/80'
          )}
        >
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              isDenied
                ? 'bg-destructive'
                : isPendingApproval
                  ? 'bg-amber-500'
                  : 'bg-primary',
              (isRunning || (isPendingApproval && (!recoveryState || recoveryState === 'live'))) && 'animate-pulse'
            )}
          />
          {badgeLabel}
        </span>
      </div>
    </div>
  );
};

const isActiveToolTraceStatus = (status: ToolTrace['status'], recoveryState?: ToolTrace['recovery_state']): boolean =>
  (!recoveryState || recoveryState === 'live') && (status === 'running' || status === 'pending_approval');

const getToolTraceGroupExecutionMode = (
  tools: ToolRenderTrace[]
): ToolTrace['execution_mode'] | undefined => {
  if (tools.some((tool) => tool.executionMode === 'parallel')) {
    return 'parallel';
  }

  const activeBatchCounts = new Map<string, number>();
  for (const tool of tools) {
    if (!tool.batchId || !isActiveToolTraceStatus(tool.status, tool.recoveryState)) continue;
    activeBatchCounts.set(tool.batchId, (activeBatchCounts.get(tool.batchId) ?? 0) + 1);
  }
  if (Array.from(activeBatchCounts.values()).some((count) => count > 1)) {
    return 'parallel';
  }

  if (tools.some((tool) => tool.executionMode === 'sequential')) {
    return 'sequential';
  }

  return undefined;
};

const ActiveToolTraceGroup: React.FC<{ tools: ToolRenderTrace[] }> = ({ tools }) => {
  const { t } = useTranslation();
  const allActive = tools.every((tool) => isActiveToolTraceStatus(tool.status, tool.recoveryState));
  const allUnknown = tools.every((tool) => tool.recoveryState === 'unknown');
  const executionMode = getToolTraceGroupExecutionMode(tools);
  const executionModeLabel =
    executionMode === 'parallel'
      ? t('chat.toolExecutionParallel', 'Parallel')
      : executionMode === 'sequential'
        ? t('chat.toolExecutionSequential', 'Sequential')
        : null;

  return (
    <div
      data-testid={allActive ? 'tool-traces-running' : 'tool-traces-activity'}
      data-group-status={allActive ? 'running' : allUnknown ? 'unknown' : 'mixed'}
      data-testid-group="tool-trace-group"
      className="mt-3 mb-3 rounded-lg border border-border bg-card/40 px-3 py-2"
    >
      <div className="mb-2 flex items-center gap-2 min-w-0">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-primary/20 bg-primary/10">
          <Icon name="tool" size={11} className="text-primary" />
        </span>
        <span className="text-xs font-medium text-foreground truncate">
          {allActive
            ? t('chat.runningTools', 'Running tools')
            : t('chat.toolActivity', 'Tool activity')}
        </span>
        {executionModeLabel && (
          <span
            data-testid="tool-traces-execution-mode"
            data-execution-mode={executionMode}
            className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            {executionModeLabel}
          </span>
        )}
      </div>
      <div data-testid="tool-traces-list" className="space-y-2">
        {tools.map((tool, index) => (
          <ToolTraceRow
            key={`${tool.toolName}-${tool.detail ?? ''}-${index}`}
            toolName={tool.toolName}
            detail={tool.detail}
            status={tool.status}
            recoveryState={tool.recoveryState}
          />
        ))}
      </div>
    </div>
  );
};

const CompletedToolTraceGroup: React.FC<{ tools: ToolRenderTrace[] }> = ({ tools }) => {
  const { t } = useTranslation();

  return (
    <div
      data-testid="tool-traces-completed"
      data-group-status="done"
      data-testid-group="tool-trace-group"
      className="mt-3 mb-3 rounded-lg border border-border bg-card/40 px-3 py-1"
    >
      <Accordion type="single" collapsible>
        <AccordionItem value="tool-traces" className="border-b-0">
          <AccordionTrigger
            data-testid="tool-traces-completed-trigger"
            className="py-2 hover:no-underline"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-primary/20 bg-primary/10">
                <Icon name="tool" size={11} className="text-primary" />
              </span>
              <span className="truncate text-xs font-medium text-foreground">
                {t('chat.toolsUsedCount', {
                  count: tools.length,
                  defaultValue: '{{count}} tools used',
                })}
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <div data-testid="tool-traces-list" className="space-y-2 pt-1">
              {tools.map((tool, index) => (
                <ToolTraceRow
                  key={`${tool.toolName}-${tool.detail ?? ''}-${index}`}
                  toolName={tool.toolName}
                  detail={tool.detail}
                  status={tool.status}
                  recoveryState={tool.recoveryState}
                />
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
};

const MarkdownRendererBase: React.FC<MarkdownRendererProps> = ({
  content,
  className,
  isStreaming = false,
  toolTraces,
}) => {
  const blocks = useMemo<RenderBlock[]>(
    () => buildRenderState(content, isStreaming, toolTraces),
    [content, isStreaming, toolTraces]
  );

  return (
    <div className={cn('markdown-content', className)}>
      {blocks.map((block, index) => {
        if (block.type === 'thinking') {
          return (
            <ThinkingBlock key={`thinking-${index}`} content={block.content} blockKey={index}>
              <Suspense fallback={<PlainMarkdownFallback content={block.content} />}>
                <MarkdownRichContent content={block.content} />
              </Suspense>
            </ThinkingBlock>
          );
        }

        if (block.type === 'tool_group') {
          const anyUnresolvedTool = block.tools.some((tool) =>
            isActiveToolTraceStatus(tool.status, tool.recoveryState) ||
            tool.recoveryState === 'unknown' || tool.recoveryState === 'replayable',
          );
          return anyUnresolvedTool ? (
            <ActiveToolTraceGroup key={`tools-${index}`} tools={block.tools} />
          ) : (
            <CompletedToolTraceGroup key={`tools-${index}`} tools={block.tools} />
          );
        }

        return (
          <Suspense key={`text-${index}`} fallback={<PlainMarkdownFallback content={block.content} />}>
            <MarkdownRichContent content={block.content} />
          </Suspense>
        );
      })}
    </div>
  );
};

export const __testables = {
  buildRenderState,
  buildStructuredToolGroups,
  getToolTraceIconName,
  splitLegacyToolBlocks,
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
