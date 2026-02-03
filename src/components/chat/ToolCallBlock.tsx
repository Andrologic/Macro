import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import type { ChatToolCall, McpToolResult } from '../../types/mcp';

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error';

export interface ToolCallBlockProps {
  toolCall: ChatToolCall;
  result?: McpToolResult;
  status: ToolCallStatus;
  /** Server name for display */
  serverName?: string;
}

/**
 * ToolCallBlock - Renders a tool invocation inline in chat
 * 
 * Shows:
 * - Tool name and server
 * - Input arguments (collapsible)
 * - Execution status
 * - Result or error (collapsible)
 */
export const ToolCallBlock: React.FC<ToolCallBlockProps> = ({
  toolCall,
  result,
  status,
  serverName,
}) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  // Parse tool name (may be prefixed with serverId__)
  const displayName = toolCall.function.name.includes('__')
    ? toolCall.function.name.split('__')[1]
    : toolCall.function.name;

  // Parse arguments
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    args = { raw: toolCall.function.arguments };
  }

  const hasArgs = Object.keys(args).length > 0;
  const hasResult = result && result.content && result.content.length > 0;
  const hasError = result && !result.success;

  // Get status icon and color
  const statusConfig = {
    pending: { icon: 'clock' as const, color: 'text-muted-foreground', bg: 'bg-muted/50' },
    running: { icon: 'loader' as const, color: 'text-primary', bg: 'bg-primary/10' },
    success: { icon: 'check-circle' as const, color: 'text-green-500', bg: 'bg-green-500/10' },
    error: { icon: 'alert-circle' as const, color: 'text-destructive', bg: 'bg-destructive/10' },
  };

  const { icon, color, bg } = statusConfig[status];

  // Format result content for display
  const formatResultContent = (): string => {
    if (!result?.content) return '';
    
    return result.content
      .map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return `[Image: ${c.mimeType}]`;
        if (c.type === 'resource') return c.resource.text || `[Resource: ${c.resource.uri}]`;
        return '';
      })
      .join('\n');
  };

  return (
    <div className={cn(
      'my-3 rounded-lg border overflow-hidden',
      hasError ? 'border-destructive/30' : 'border-border/50',
      bg
    )}>
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors"
      >
        {/* Status icon */}
        <div className={cn('shrink-0', color)}>
          <Icon
            name={icon}
            size={16}
            className={status === 'running' ? 'animate-spin' : ''}
          />
        </div>

        {/* Tool info */}
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-foreground">
              {displayName}
            </span>
            {serverName && (
              <span className="text-xs text-muted-foreground">
                via {serverName}
              </span>
            )}
          </div>
          {!isExpanded && hasArgs && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {Object.entries(args)
                .slice(0, 3)
                .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                .join(', ')}
              {Object.keys(args).length > 3 && '...'}
            </p>
          )}
        </div>

        {/* Expand indicator */}
        <Icon
          name="chevron-down"
          size={14}
          className={cn(
            'text-muted-foreground shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border/50 px-4 py-3 space-y-3">
          {/* Arguments */}
          {hasArgs && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">
                {t('chat.toolArguments', 'Arguments')}
              </p>
              <pre className="text-xs bg-card/50 rounded-md p-2 overflow-x-auto font-mono text-foreground/80">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {/* Result */}
          {(hasResult || hasError) && (
            <div>
              <p className={cn(
                'text-xs font-medium mb-1.5',
                hasError ? 'text-destructive' : 'text-muted-foreground'
              )}>
                {hasError ? t('chat.toolError', 'Error') : t('chat.toolResult', 'Result')}
              </p>
              <pre className={cn(
                'text-xs rounded-md p-2 overflow-x-auto font-mono',
                hasError
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-card/50 text-foreground/80'
              )}>
                {hasError ? result.error : formatResultContent()}
              </pre>
            </div>
          )}

          {/* Pending/Running status */}
          {status === 'pending' && (
            <p className="text-xs text-muted-foreground italic">
              {t('chat.toolPending', 'Waiting to execute...')}
            </p>
          )}
          {status === 'running' && (
            <p className="text-xs text-primary italic">
              {t('chat.toolRunning', 'Executing tool...')}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCallBlock;
