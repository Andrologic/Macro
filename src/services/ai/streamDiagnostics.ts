import {
  type StreamTimelineEvent,
  type StreamingChatOptions,
} from './contracts';
import {
  ProviderRuntimeError,
  isContextOverflowError,
} from './providerErrors';
import * as tauriIpc from '../tauriIpc';
import type { AppMode } from '../../types';
import { devLogger } from '../../utils/devLogger';

export const logStreamingDiagnostic = (
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  details: Record<string, string | number | boolean | null | undefined>,
): void => {
  const message = JSON.stringify({ event, ...details });
  void tauriIpc.frontendLog({ level, scope: 'streaming_chat', message }).catch(() => undefined);
};

export const classifyProviderDiagnosticCategory = (error: unknown): string => {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('system message must be at the beginning')) {
    return 'system_message_order';
  }
  if (isContextOverflowError(message)) return 'context_overflow';
  if (error instanceof ProviderRuntimeError) return error.kind;
  return 'unknown';
};

export const emitStreamTimeline = (
  options: Pick<
    StreamingChatOptions,
    'providerId' | 'providerType' | 'onTimeline'
  >,
  event: StreamTimelineEvent
) => {
  if (options.onTimeline) {
    try {
      options.onTimeline(event);
    } catch (error) {
      devLogger.warn('Provider stream timeline callback failed', {
        error,
        providerId: options.providerId,
        providerType: options.providerType,
        requestId: event.request_id,
        phase: event.phase,
      });
    }
    return;
  }

  devLogger.info('Provider stream timeline', {
    providerId: options.providerId,
    providerType: options.providerType,
    requestId: event.request_id,
    phase: event.phase,
    elapsedMs: event.elapsed_ms,
  });
};

export const stripThinkingBlocks = (content: string): string =>
  content.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/\s+/g, ' ').trim();

export const hasMeaningfulVisibleAssistantText = (content: string): boolean =>
  stripThinkingBlocks(content).length > 0;

export const summarizeProviderTextPresence = (
  items?: unknown[]
): {
  hasMessageItem: boolean;
  hasOutputTextItem: boolean;
  hasTextContentPart: boolean;
} => {
  const summary = {
    hasMessageItem: false,
    hasOutputTextItem: false,
    hasTextContentPart: false,
  };

  if (!Array.isArray(items)) {
    return summary;
  }

  for (const item of items) {
    const typedItem = item as { type?: unknown; content?: unknown };
    if (typedItem?.type === 'message') {
      summary.hasMessageItem = true;
    }
    if (typedItem?.type === 'output_text') {
      summary.hasOutputTextItem = true;
    }

    if (!Array.isArray(typedItem?.content)) {
      continue;
    }

    for (const part of typedItem.content as Array<{ type?: unknown }>) {
      if (part?.type === 'output_text' || part?.type === 'text') {
        summary.hasTextContentPart = true;
      }
    }
  }

  return summary;
};

export const shouldRetryArchitectPostToolResponse = (params: {
  mode?: AppMode;
  usedToolNames: Set<string>;
  visibleContent: string;
  retryCount: number;
}): boolean =>
  params.mode === 'Architect' &&
  params.usedToolNames.size > 0 &&
  params.retryCount < 1 &&
  !hasMeaningfulVisibleAssistantText(params.visibleContent);

export const logArchitectToolOnlyOutcome = (params: {
  mode?: AppMode;
  usedToolNames: Set<string>;
  visibleContent: string;
  retryCount: number;
  providerItems?: unknown[];
  stage: 'retry' | 'final-empty';
}): void => {
  if (params.mode !== 'Architect' || params.usedToolNames.size === 0) {
    return;
  }

  const providerPresence = summarizeProviderTextPresence(params.providerItems);
  devLogger.info('Architect turn finished after tools without visible text', {
    mode: params.mode,
    stage: params.stage,
    toolNames: Array.from(params.usedToolNames),
    visibleTextLength: stripThinkingBlocks(params.visibleContent).length,
    retryCount: params.retryCount,
    hasMessageItem: providerPresence.hasMessageItem,
    hasOutputTextItem: providerPresence.hasOutputTextItem,
    hasTextContentPart: providerPresence.hasTextContentPart,
  });
};
