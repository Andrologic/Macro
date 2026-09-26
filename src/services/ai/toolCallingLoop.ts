import type { ProviderTurnState } from '../../types';
import { ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT } from '../../domains/chat/prompts';
import { getMacroToolRegistryEntry, type JsonSchema } from '../../shared/macroToolRegistry';
import { normalizeChatMaxTurns } from '../chatTurnLimits';
import type { StreamMessage, StreamingChatOptions, StreamingTurnResult, ToolCall, ToolResult, StreamCompletionReason } from './contracts';
import { createStreamAccumulator } from './streamAccumulator';
import { cloneStreamMessage, cloneProviderInputItems } from './jsonValues';
import { collectAllowedTools } from './toolDefinitions';
import { runToolBatch } from './toolCallRunner';
import { getValidToolCalls } from './toolCallProtocol';
import { INCOMPLETE_RECOVERY_PROMPT, isIncompleteCompletionReason, recoveredCompletionReason, shouldRetryMissingRequiredTool, stripContinuationOverlap } from './completionRecovery';
import { getMissingChatGptVisibleTurnSuffix } from './responsesCodec';
import { hasMeaningfulVisibleAssistantText, logArchitectToolOnlyOutcome, shouldRetryArchitectPostToolResponse } from './streamDiagnostics';

export type StreamAccumulator = ReturnType<typeof createStreamAccumulator>;

export interface LoopTurn {
  result: StreamingTurnResult;
  // Native tools can finish inside streamTurn, before the loop accepts its text.
  executedToolItems?: unknown[];
  executedToolNames?: string[];
  projectAssistant: (content: string, calls: ToolCall[], recovering: boolean, incomplete: boolean) => {
    items: unknown[];
    state?: ProviderTurnState;
  };
}

// The adapters own wire formats and transport retries. Turn limits, recovery,
// tools, interruptions and transcript accumulation have one owner below.
export interface ToolCallingAdapter {
  kind: 'native' | 'generic';
  streamTurn: (input: {
    messages: StreamMessage[];
    tools: unknown[];
    turnCount: number;
    recovering: boolean;
    onDelta: (delta: string) => void;
  }) => Promise<LoopTurn | { stopped: string }>;
  projectTool: (result: ToolResult, calls: ToolCall[]) => unknown;
  afterToolResults: (messages: StreamMessage[], results: ToolResult[]) => void;
  assertTerminal?: (content: string, calls: ToolCall[]) => void;
}

export async function runToolCallingLoop(
  options: StreamingChatOptions,
  adapter: ToolCallingAdapter,
  accumulator: StreamAccumulator,
) {
  const allowedTools = new Set(options.allowedToolIds ?? []);
  const tools = collectAllowedTools({
    allowedTools,
    enableWebSearch: options.enableWebSearch ?? true,
    enableWebFetch: options.enableWebFetch ?? true,
    webSearchOptions: options.webSearchOptions,
    mcpTools: options.mcpTools,
    skillToolIds: options.skillToolIds,
    runnableSkillToolIds: options.runnableSkillToolIds,
  });
  const schemas = new Map<string, JsonSchema>();
  for (const name of allowedTools) {
    const entry = getMacroToolRegistryEntry(name);
    if (entry) schemas.set(name, entry.parameters);
  }
  let messages = [...options.messages];
  const transcript: unknown[] = [];
  let providerTurnState: ProviderTurnState | undefined;
  const maxTurns = normalizeChatMaxTurns(options.maxTurns);
  let turnCount = 0;
  let guidedRetryCount = 0;
  let architectRetryCount = 0;
  let enforceGuidedRetry = Boolean(options.guidedToolRetry);
  let recoveryCause: 'length' | 'incomplete' | null = null;
  const usedToolNames = new Set<string>();
  // Native live context also contains completed results from a turn interrupted
  // before projectAssistant could add it to the settled transcript.
  const complete = (completionReason?: StreamCompletionReason) => ({
    ...accumulator.buildResult(),
    providerInputItems: cloneProviderInputItems(accumulator.snapshotLiveContext().providerInputItems ?? transcript),
    ...(providerTurnState ? { providerTurnState } : {}),
    ...(completionReason ? { completionReason } : {}),
  });
  const consumeSteers = () => {
    const steers = options.consumePendingSteers?.() ?? [];
    if (!steers.length) return false;
    messages.push(...steers.map(cloneStreamMessage));
    turnCount += 1;
    return true;
  };
  try {
    while (maxTurns === null || turnCount < maxTurns) {
      if (options.signal?.aborted) return complete();
      const recovering = recoveryCause !== null;
      const bufferOutput = enforceGuidedRetry || recovering;
      let streamedContent = '';
      const turn = await adapter.streamTurn({
        messages, tools: recovering ? [] : tools, turnCount, recovering,
        onDelta: (delta) => {
          streamedContent += delta;
          if (!bufferOutput) accumulator.appendProviderDelta(delta);
        },
      });
      if (options.signal?.aborted) return complete();
      if ('stopped' in turn) {
        accumulator.appendSystemChunk(turn.stopped, true);
        return complete();
      }
      const result = turn.result;
      result.toolTraces?.forEach(accumulator.upsertToolTraceFromProvider);
      if (result.hiddenContext) accumulator.addHiddenContextBlock(result.hiddenContext);
      const content = result.content || streamedContent;
      const replayContent = recovering
        ? stripContinuationOverlap(accumulator.buildResult().visibleContent, content)
        : content;
      const rawCalls = getValidToolCalls(result.toolCalls);
      const incomplete = isIncompleteCompletionReason(result.completionReason);
      const recoveryAttemptedTool = recovering && rawCalls.length > 0;
      const calls = incomplete || recoveryAttemptedTool ? [] : rawCalls;

      if (enforceGuidedRetry && !incomplete && !recovering && shouldRetryMissingRequiredTool(options.guidedToolRetry, calls, guidedRetryCount, turn.executedToolNames)) {
        // Reject the answer, not effects that already completed in the native turn.
        const executedItems = cloneProviderInputItems(turn.executedToolItems);
        if (executedItems?.length) {
          transcript.push(...executedItems);
          accumulator.setProviderContext({ providerInputItems: transcript, providerTurnState });
          messages.push({ role: 'assistant', content: '', provider_input_items: executedItems });
        }
        guidedRetryCount += 1;
        messages.push({ role: 'system', content: options.guidedToolRetry?.retrySystemPrompt || '' });
        turnCount += 1;
        continue;
      }
      enforceGuidedRetry = false;
      if (bufferOutput) {
        if (replayContent) accumulator.appendProviderDelta(replayContent);
      } else {
        const suffix = getMissingChatGptVisibleTurnSuffix(streamedContent, content);
        if (suffix) accumulator.appendProviderDelta(suffix);
      }
      accumulator.flushProviderDelta();
      const transcriptStart = transcript.length;
      const projected = turn.projectAssistant(replayContent, [], recovering, incomplete);
      const requestProjection = calls.length ? turn.projectAssistant(replayContent, calls, recovering, incomplete) : projected;
      providerTurnState = projected.state ?? providerTurnState;
      if (replayContent.trim() || calls.length || projected.items.length) {
        if (projected.items.length) {
          transcript.push(...projected.items);
          accumulator.setProviderContext({ providerInputItems: transcript, providerTurnState });
        }
        messages.push({
          role: 'assistant', content: replayContent,
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(requestProjection.items.length ? { provider_input_items: requestProjection.items } : {}),
          ...(requestProjection.state ? { provider_turn_state: requestProjection.state } : {}),
        });
      }
      if (!calls.length) {
        if (incomplete && !recovering) {
          recoveryCause = result.completionReason === 'length' ? 'length' : 'incomplete';
          messages.push({ role: 'system', content: INCOMPLETE_RECOVERY_PROMPT });
          continue;
        }
        if (incomplete) return complete(result.completionReason);
        if (recoveryAttemptedTool) return complete('incomplete');
        // Keep native steering precedence while HTTP keeps its post-tool retry first.
        if (adapter.kind === 'native' && consumeSteers()) continue;
        const diagnostic = {
          mode: options.mode, usedToolNames, visibleContent: content,
          retryCount: architectRetryCount,
          ...(adapter.kind === 'native' ? { providerItems: projected.items } : {}),
        };
        if (shouldRetryArchitectPostToolResponse(diagnostic)) {
          logArchitectToolOnlyOutcome({ ...diagnostic, stage: 'retry' });
          architectRetryCount += 1;
          messages.push({ role: 'system', content: ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT });
          turnCount += 1;
          continue;
        }
        if (options.mode === 'Architect' && usedToolNames.size && !hasMeaningfulVisibleAssistantText(content)) {
          logArchitectToolOnlyOutcome({ ...diagnostic, stage: 'final-empty' });
        }
        if (adapter.kind === 'generic' && consumeSteers()) continue;
        adapter.assertTerminal?.(content, calls);
        return complete(recoveryCause ? recoveredCompletionReason(recoveryCause) : result.completionReason);
      }
      const completedCalls: ToolCall[] = [];
      const completedItems: unknown[] = [];
      const { toolResults, interruptResolution } = await runToolBatch({
        calls, messages, options, allowedTools, schemas, accumulator,
        batchId: `${adapter.kind}-turn-${turnCount}`, usedToolNames,
        onCompletedResult: (toolResult) => {
          completedCalls.push(calls.find(call => call.id === toolResult.tool_call_id)!);
          const item = adapter.projectTool(toolResult, calls);
          completedItems.push(item);
          const progress = turn.projectAssistant(replayContent, completedCalls, recovering, incomplete);
          providerTurnState = progress.state ?? providerTurnState;
          transcript.splice(transcriptStart, transcript.length - transcriptStart, ...progress.items, ...completedItems);
          accumulator.setProviderContext({ providerInputItems: transcript, providerTurnState });
          messages.push({ role: 'tool', content: toolResult.content,
            tool_call_id: toolResult.tool_call_id, provider_input_items: [item] });
        },
      });
      if (interruptResolution) {
        accumulator.replaceVisibleContent(interruptResolution.visibleContent);
        return complete();
      }
      if (toolResults.length) {
        if (options.onBeforeFollowUpRequest) {
          const compacted = await options.onBeforeFollowUpRequest({
            reason: 'tool_results', messages: messages.map(cloneStreamMessage),
            turnCount, toolResultCount: toolResults.length,
          });
          const next = Array.isArray(compacted) ? compacted : compacted?.messages;
          if (Array.isArray(next)) messages = next.map(cloneStreamMessage);
        }
        adapter.afterToolResults(messages, toolResults);
      }
      turnCount += 1;
      if (maxTurns !== null && toolResults.length && turnCount >= maxTurns) {
        accumulator.markRunningToolTracesDone();
        return complete('tool_turn_limit');
      }
    }
    return complete();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return complete();
    throw error;
  }
}
