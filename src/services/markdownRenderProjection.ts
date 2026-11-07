import type { ToolTrace } from '../types';
import { classifyToolTraceRecovery, isToolTrace } from './toolTraceState';
import { parseAssistantQuestionnaireState } from './chatQuestionnaires';

export type RenderSegment =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string; partial: boolean };

export interface ToolRenderTrace {
  toolName: string;
  detail?: string;
  status: ToolTrace['status'];
  recoveryState?: ToolTrace['recovery_state'];
  executionMode?: ToolTrace['execution_mode'];
  batchId?: string;
  order?: number;
}

export type RenderBlock =
  | RenderSegment
  | { type: 'tool_group'; tools: ToolRenderTrace[] };

const splitThinkBlocks = (content: string): RenderSegment[] => {
  const blocks: RenderSegment[] = [];
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
        blocks.push({ type: 'thinking', content: thinkContent, partial: false });
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
          blocks.push({ type: 'thinking', content: thinkContent, partial: false });
        }
        remaining = rest.slice(nextClose.index! + nextClose[0].length);
      } else {
        const thinkContent = rest.trim();
        if (thinkContent) {
          blocks.push({ type: 'thinking', content: thinkContent, partial: true });
        }
        break;
      }
    }
  }

  return blocks;
};

export const splitLegacyToolBlocks = (
  content: string,
  isStreaming: boolean
): RenderBlock[] => {
  const blocks: RenderBlock[] = [];
  const tools: ToolRenderTrace[] = [];
  const lines = content.split('\n');
  const textBuffer: string[] = [];
  const toolStartRegex = /^(?:\[\s*TOOL\s*\]|🔧\s*\*\*Tool:\*\*)\s*([a-zA-Z0-9_-]+)(?:\s*\((.+?)\))?\s*$/i;
  const toolDoneRegex = /^\[\s*TOOL_DONE\s*\]\s*([a-zA-Z0-9_-]+)(?:\s*\((.+?)\))?\s*$/i;
  const pendingTools: ToolRenderTrace[] = [];

  const flushTools = () => {
    if (tools.length === 0) return;
    blocks.push({ type: 'tool_group', tools: [...tools] });
    tools.length = 0;
  };

  const flushText = () => {
    if (textBuffer.length === 0) return;
    const text = textBuffer.join('\n');
    if (text.trim()) {
      flushTools();
      blocks.push({ type: 'text', content: text });
    }
    textBuffer.length = 0;
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    const startMatch = trimmedLine.match(toolStartRegex);
    if (startMatch) {
      flushText();
      const nextTool: ToolRenderTrace = {
        toolName: startMatch[1],
        detail: startMatch[2],
        status: 'running',
        recoveryState: isStreaming ? 'live' : 'unknown',
      };
      const previous = tools[tools.length - 1];
      const sameAsPrevious =
        previous?.toolName === nextTool.toolName &&
        (previous.detail || '').normalize('NFC') === (nextTool.detail || '').normalize('NFC') &&
        previous.status === nextTool.status;
      if (!sameAsPrevious) {
        tools.push(nextTool);
        pendingTools.push(nextTool);
      }
      continue;
    }

    const doneMatch = trimmedLine.match(toolDoneRegex);
    if (doneMatch) {
      flushText();
      const doneToolName = doneMatch[1];
      const doneDetail = doneMatch[2];
      const pendingIndex = pendingTools.findIndex((tool) => {
        if (tool.toolName !== doneToolName || tool.status !== 'running') return false;
        if (!doneDetail) return true;
        return (tool.detail || '').normalize('NFC') === doneDetail.normalize('NFC');
      });

      if (pendingIndex !== -1) {
        const tool = pendingTools[pendingIndex];
        if (tool) {
          tool.status = 'done';
          tool.recoveryState = 'completed';
        }
        pendingTools.splice(pendingIndex, 1);
      }
      continue;
    }

    textBuffer.push(line);
  }

  flushText();
  flushTools();
  return blocks;
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

export const buildStructuredToolGroups = (
  content: string,
  toolTraces: ToolTrace[]
): RenderBlock[] => {
  const blocks: RenderBlock[] = [];
  let cursor = 0;
  let toolIndex = 0;

  const pushContentSlice = (slice: string) => {
    for (const segment of splitThinkBlocks(slice)) {
      blocks.push(segment);
    }
  };

  while (toolIndex < toolTraces.length) {
    const anchor = Math.max(
      cursor,
      Math.min(content.length, toolTraces[toolIndex]?.visible_offset ?? content.length)
    );

    if (anchor > cursor) {
      pushContentSlice(content.slice(cursor, anchor));
      cursor = anchor;
    }

    const groupTools: ToolRenderTrace[] = [];
    while (toolIndex < toolTraces.length) {
      const trace = toolTraces[toolIndex]!;
      const traceAnchor = Math.max(
        cursor,
        Math.min(content.length, trace.visible_offset ?? content.length)
      );
      if (traceAnchor !== anchor) break;
      groupTools.push({
        toolName: trace.tool_name,
        detail: trace.detail,
        status: trace.status,
        recoveryState: trace.recovery_state ?? classifyToolTraceRecovery(trace, { live: true }),
        executionMode: trace.execution_mode,
        batchId: trace.batch_id,
        order: trace.order,
      });
      toolIndex += 1;
    }

    if (groupTools.length > 0) {
      groupTools.sort((a, b) => {
        const aOrder = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
        const bOrder = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder;
      });
      blocks.push({ type: 'tool_group', tools: groupTools });
    }
  }

  if (cursor < content.length) {
    pushContentSlice(content.slice(cursor));
  }

  return blocks;
};

export const buildRenderState = (
  content: string,
  isStreaming: boolean,
  toolTraces?: ToolTrace[] | null
): RenderBlock[] => {
  if (toolTraces && toolTraces.length > 0) {
    return buildStructuredToolGroups(content, toolTraces);
  }

  const normalizedContent = normalizeToolCallMarkup(content);
  const blocks: RenderBlock[] = [];

  for (const segment of splitThinkBlocks(normalizedContent)) {
    if (segment.type === 'thinking') {
      blocks.push(segment);
      continue;
    }
    blocks.push(...splitLegacyToolBlocks(segment.content, isStreaming));
  }

  return blocks;
};

/** UTF-8 source budget before parsing; capture/page budgets belong to the caller. */
export const REFLECTION_SOURCE_MAX_BYTES = 1024 * 1024;
export const REFLECTION_MAX_BLOCKS = 128;

export interface AssistantReflectionBlock {
  /** Index in the actual renderer output, including text and tool groups. */
  renderBlockIndex: number;
  order: number;
  content: string;
  partial: boolean;
}

export type AssistantReflectionProjection =
  | { state: 'ready'; blocks: AssistantReflectionBlock[] }
  | { state: 'absent' | 'withheld' | 'source_too_large'; blocks: [] };

export type AssistantReflectionSource = {
  content: string;
  isStreaming?: boolean;
  toolTraces?: ToolTrace[] | null;
} & (
  | { presentation: 'renderer' }
  | { presentation: 'persisted'; hasHiddenContext: boolean }
);

/**
 * Projects only thinking blocks emitted by buildRenderState. The caller supplies
 * an authenticated assistant source and applies policy to the whole projection
 * before pagination. This function establishes neither authority nor provenance.
 */
export const projectAssistantReflections = (
  source: AssistantReflectionSource,
): AssistantReflectionProjection => {
  if (source.content.length > REFLECTION_SOURCE_MAX_BYTES ||
      new TextEncoder().encode(source.content).byteLength > REFLECTION_SOURCE_MAX_BYTES ||
      (source.toolTraces?.length ?? 0) > REFLECTION_MAX_BLOCKS) {
    return { state: 'source_too_large', blocks: [] };
  }

  // A byte limit alone permits thousands of tiny renderer/tool/JSON objects.
  // Scan without allocating a match array before entering presentation parsers.
  let separators = 0;
  for (const character of source.content) {
    if ('\n{}[],'.includes(character) && ++separators > 4096) return { state: 'source_too_large', blocks: [] };
  }
  const markers = /<\s*\/?\s*(?:think|thinking)\s*>|<tool_call\b|^(?:\s*\[\s*TOOL(?:_DONE)?\s*\]|\s*🔧\s*\*\*Tool:\*\*)/gim;
  let markerCount = 0;
  while (markers.exec(source.content)) if (++markerCount > 256) return { state: 'source_too_large', blocks: [] };

  // isToolTrace intentionally accepts legacy offset shapes. Those can produce
  // NaN anchors in the renderer; never enter that grouping loop for an export.
  if (source.toolTraces?.some((trace) => !isToolTrace(trace) ||
      (trace.visible_offset != null &&
        (typeof trace.visible_offset !== 'number' || !Number.isFinite(trace.visible_offset))))) {
    return { state: 'withheld', blocks: [] };
  }

  let content = source.content;
  if (source.presentation === 'persisted') {
    const presentation = parseAssistantQuestionnaireState(content).content;
    // A valid hidden questionnaire instead uses content.trim(). Without reading
    // hidden_context we can only proceed when both branches render the same text.
    if (source.hasHiddenContext && presentation !== content.trim()) {
      return { state: 'withheld', blocks: [] };
    }
    content = source.hasHiddenContext ? content.trim() : presentation;
  }

  // The permissive renderer can interpret tags inside tool payloads as thinking.
  // Keep its presentation intact, but retain such a source instead of exporting
  // arguments/results or questionnaire choices as reflections.
  const thinkingTag = /<\s*\/?\s*(?:think|thinking)\s*>/i;
  // Legacy labels interpolate raw multi-line tool arguments. Neither a closing
  // parenthesis nor TOOL_DONE attests where such an argument ends. Any later
  // thinking marker is ambiguous, even with otherwise valid structured anchors.
  const legacyLabel = /^(?:\s*\[\s*TOOL(?:_DONE)?\s*\]|\s*🔧\s*\*\*Tool:\*\*|\s*🔍\s*\*\*Recherche web:\*\*|\s*\[System:)/gim.exec(content);
  if (legacyLabel && thinkingTag.test(content.slice(legacyLabel.index))) {
    return { state: 'withheld', blocks: [] };
  }

  const payloads = content.match(
    /<(tool_call|tool_result|tool_context|questionnaire_context|questionnaire_response_context)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|(?![\s\S]))|\[quick-replies\][\s\S]*?(?:\[\/quick-replies\]|(?![\s\S]))|^(?:\s*\[\s*TOOL(?:_DONE)?\s*\]|\s*🔧\s*\*\*Tool:\*\*)[^\n]*/gim,
  );
  if (payloads?.some((payload) => thinkingTag.test(payload) || thinkingTag.test(normalizeToolCallMarkup(payload)))) {
    return { state: 'withheld', blocks: [] };
  }

  const renderBlocks = buildRenderState(content, source.isStreaming ?? false, source.toolTraces);
  const blocks: AssistantReflectionBlock[] = [];
  for (const [renderBlockIndex, block] of renderBlocks.entries()) {
    if (block.type !== 'thinking') continue;
    if (blocks.length === REFLECTION_MAX_BLOCKS) {
      return { state: 'source_too_large', blocks: [] };
    }
    blocks.push({ renderBlockIndex, order: blocks.length, content: block.content, partial: block.partial });
  }
  return blocks.length ? { state: 'ready', blocks } : { state: 'absent', blocks: [] };
};
