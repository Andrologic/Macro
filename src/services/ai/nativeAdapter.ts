import type { StreamingChatOptions, StreamingTurnResult } from './contracts';
import type { ReasoningEffort } from '../../types';
import type { ToolCallingAdapter, StreamAccumulator } from './toolCallingLoop';
import { streamNativeTurnViaTauri } from './nativeTurnTransport';
import { classifyReasoningRejection } from './providerErrors';
import type { ActiveStreamResources } from './streamResources';
import type { ReasoningCompatibility } from './reasoningCompatibility';
import { emitStreamTimeline } from './streamDiagnostics';
import { formatToolTraceDetail } from './toolPresentation';
import { buildNativeReasoningVisibleTurnContent, buildAssistantProviderInputItemsFromTurn, buildFunctionCallOutputProviderInputItem, isEmptyTerminalChatGptTurn } from './responsesCodec';
import { cloneProviderInputItems, isRecord } from './jsonValues';
import { devLogger } from '../../utils/devLogger';

// Truncated responses may contain unfinished calls. Only pairs with an actual
// result can be replayed during continuation; media and error metadata stay intact.
const completedToolItems = (items: unknown[] | undefined): unknown[] => {
  const records = (items ?? []).filter(isRecord);
  const calls = new Set(records.filter(item => item.type === 'function_call').map(item => item.call_id));
  const outputs = new Set(records.filter(item => item.type === 'function_call_output').map(item => item.call_id));
  return cloneProviderInputItems(records.filter(item =>
    typeof item.call_id === 'string' && calls.has(item.call_id) && outputs.has(item.call_id)
    && (item.type === 'function_call' || item.type === 'function_call_output'),
  )) ?? [];
};

export function createNativeAdapter(options: StreamingChatOptions, accumulator: StreamAccumulator, reasoning: ReasoningCompatibility, resources?: ActiveStreamResources): ToolCallingAdapter {
  const { providerId, providerType, modelId } = options;
  let currentReasoningEffort = options.reasoningTransportMode === 'none' ? null : options.reasoningEffort;
  let didRetryWithoutReasoning = false;
  const rejectedReasoningEfforts = new Set<ReasoningEffort>();
  return {
    kind: 'native',
    streamTurn: async ({ messages, tools, recovering, onDelta, onRetry }) => {
      // Live callbacks contain the current turn's cumulative results only.
      // Keep the previous turns once, without re-appending each live snapshot.
      const previousContext = accumulator.snapshotLiveContext();
      let streamedTurnContent = '';
      let turnResult: StreamingTurnResult;
      while (true) {
        try {
          turnResult = await streamNativeTurnViaTauri({
            sessionId: options.sessionId,
            providerId,
            providerType,
            modelId,
            reasoningEffort: currentReasoningEffort,
            conversationId: options.conversationId,
            messages,
            tools,
            allowedToolIds: recovering ? [] : options.allowedToolIds,
            workspacePath: options.workspacePath,
            defaultWorkspacePath: options.defaultWorkspacePath,
            projectMounts: options.projectMounts,
            virtualRootEnabled: options.virtualRootEnabled,
            focusedProjectId: options.focusedProjectId,
            copilotSendTimeoutMs: options.copilotSendTimeoutMs,
            signal: options.signal,
            onTimeline: (event) => emitStreamTimeline(options, event),
            onDelta: (delta) => {
              streamedTurnContent += delta;
              onDelta(delta);
            },
            onToolTrace: (toolTrace) => {
              accumulator.upsertToolTraceFromProvider(toolTrace);
            },
            onToolCall: options.onToolCall,
            onToolResult: options.onToolResult,
            onLiveToolResult: ({ toolName, args, toolCallId, result, providerInputItems }) => {
              const detail = formatToolTraceDetail(toolName, args);
              accumulator.addLiveOnlyHiddenToolContext(toolCallId, toolName, detail, result);
              if (providerInputItems) accumulator.setProviderContext({
                providerInputItems: [...(previousContext.providerInputItems ?? []), ...providerInputItems],
                providerTurnState: previousContext.providerTurnState,
              });
            },
          }, resources);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const rejection = classifyReasoningRejection(message);
          const rejectedEffort = currentReasoningEffort;
          if (rejection === 'parameter' && rejectedEffort && !didRetryWithoutReasoning) {
            didRetryWithoutReasoning = true;
            currentReasoningEffort = null;
            reasoning.disableReasoning();
            await onRetry?.();
            streamedTurnContent = '';
            continue;
          }
          if (
            rejection === 'value' &&
            rejectedEffort &&
            !rejectedReasoningEfforts.has(rejectedEffort)
          ) {
            rejectedReasoningEfforts.add(rejectedEffort);
            reasoning.disableEffort(rejectedEffort);
            currentReasoningEffort = null;
            await onRetry?.();
            streamedTurnContent = '';
            continue;
          }
          throw error;
        }
      }
      const content = providerType === 'chatgpt' || providerType === 'copilot'
        ? buildNativeReasoningVisibleTurnContent(turnResult.content || streamedTurnContent, turnResult.reasoningSummary)
        : turnResult.content || streamedTurnContent;
      const executedToolItems = completedToolItems(turnResult.providerInputItems);
      return {
        executedToolItems,
        executedToolNames: executedToolItems.filter(isRecord).filter(item => item.type === 'function_call' && typeof item.name === 'string').map(item => item.name as string),
        result: { ...turnResult, content, completionReason: turnResult.completionReason ?? 'completed' },
        projectAssistant: (replayContent, calls, recovering, incomplete) => {
          const pendingIds = new Set((turnResult.toolCalls ?? []).filter(call => !calls.some(accepted => accepted.id === call.id)).map(call => call.id));
          const withoutPendingCalls = (items: unknown[] | undefined) => items?.filter(item =>
            !isRecord(item) || item.type !== 'function_call' || !pendingIds.has(String(item.call_id)),
          );
          const items = recovering || incomplete
            ? [...(cloneProviderInputItems(executedToolItems) ?? []), ...buildAssistantProviderInputItemsFromTurn(replayContent, calls)]
            : cloneProviderInputItems(withoutPendingCalls(turnResult.providerInputItems)) ?? buildAssistantProviderInputItemsFromTurn(replayContent, calls);
          const state = turnResult.providerTurnState ? {
            ...turnResult.providerTurnState,
            output_items: recovering || incomplete ? cloneProviderInputItems(items) ?? [] : withoutPendingCalls(turnResult.providerTurnState.output_items) ?? [],
          } : undefined;
          return { items, state };
        },
      };
    },
    projectTool: (result) => buildFunctionCallOutputProviderInputItem(result.tool_call_id, result.content, result.blocks, result.is_error),
    afterToolResults: (_messages, results) => {
      const hasToolErrors = results.some((result) => result.is_error);
      const hasFileReadResults = results.some((result) => /^FILE:\s+/m.test(result.content));
      if (hasToolErrors || hasFileReadResults) devLogger.info('ChatGPT follow-up turn proceeding with full transcript after guarded tool results', {
        hasToolErrors, hasFileReadResults, toolResultCount: results.length,
      });
    },
    assertTerminal: (content, calls) => {
      if (providerType === 'chatgpt' && isEmptyTerminalChatGptTurn(content, calls)) {
        throw new Error('Réponse ChatGPT vide après exécution des outils.');
      }
    },
  };
}
