import type {
  ChatMessage,
  CompactionPass,
  CompactionSummarySource,
  ContextCompactionDecisionAudit,
  ContextFootprint,
  ConversationCompactionState,
  ProviderTurnState,
} from "../../types";
import type { Citation } from "../useCitationsStore";
import {
  buildContextCompactionDecisionAudit,
  type ContextCompactionDecision,
  type ManualCompactionSkipReason,
} from "../../services/contextCompaction";
import type { StreamMessage } from "../../services/streamingChat";
import type { ConversationCompactionPhase } from "../../services/contextCompactionSession";

export type ConversationContextDiagnosticsStatus = "estimating" | "ready" | "error";
export type ConversationContextDiagnosticsSource = "full" | "live_stream";
export type ConversationContextDiagnosticsRefreshMode =
  ConversationContextDiagnosticsSource;

export interface ConversationContextDiagnosticsProviderContext {
  providerId: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
}

export interface ConversationContextDiagnosticsBreakdownItem {
  id: string;
  label: string;
  tokens?: number;
  lines?: number;
  count?: number;
}

export interface RepositoryInstructionDiagnosticSource {
  projectId: string;
  projectName: string;
  sourcePath: string;
  relativePath: string;
  depth: number;
  sizeBytes: number;
}

export interface RepositoryInstructionDiagnosticIssue {
  projectId: string;
  code: string;
  sourcePath?: string | null;
  message: string;
}

export type { ManualCompactionSkipReason };

export interface ManualCompactionCompletedResult {
  outcome: "compacted";
  updatedAt: string;
  footprintBefore: ContextFootprint;
  footprintAfter: ContextFootprint;
  tokensSaved: number;
  upToMessageId: string;
  summarySource?: CompactionSummarySource;
}

export interface ManualCompactionSkippedResult {
  outcome: "skipped";
  updatedAt: string;
  reason: ManualCompactionSkipReason;
  footprintBefore: ContextFootprint;
  userTurnCount: number;
  retainedTurnCount: number;
}

export type ManualCompactionResult =
  | ManualCompactionCompletedResult
  | ManualCompactionSkippedResult;

export interface ConversationContextDiagnostics {
  status: ConversationContextDiagnosticsStatus;
  source?: ConversationContextDiagnosticsSource;
  conversationId: string;
  updatedAt: string;
  providerId?: string;
  providerType?: string;
  modelId?: string;
  modelContextWindowTokens?: number;
  contextLimitSource?: ContextFootprint["contextLimitSource"];
  isContextLimitAuthoritative?: boolean;
  contextLimitConfidence?: ContextFootprint["contextLimitConfidence"];
  contextLimitWarning?: string;
  previousModelContextWindowTokens?: number;
  modelContextWindowShrank?: boolean;
  marginTokens?: number;
  compactionDecisionAudit?: ContextCompactionDecisionAudit;
  phase?: ConversationCompactionPhase | "provider_error";
  decision?: ContextCompactionDecision;
  compactionPass?: CompactionPass;
  summaryFormatVersion?: number;
  summarySource?: CompactionSummarySource;
  footprintBefore?: ContextFootprint;
  footprintAfter?: ContextFootprint;
  ratio: number;
  usableRatio: number;
  isHardStop: boolean;
  error?: string;
  repositoryInstructionSources?: RepositoryInstructionDiagnosticSource[];
  repositoryInstructionIssues?: RepositoryInstructionDiagnosticIssue[];
  counts: {
    messages: number;
    visibleLines: number;
    hiddenContextLines: number;
    providerInputItems: number;
    providerInputItemLines: number;
    reasoningContentLines: number;
    toolResultLines: number;
    citations: number;
    activeFiles: number;
    toolFacts: number;
  };
  breakdown: ConversationContextDiagnosticsBreakdownItem[];
  topContributors: ConversationContextDiagnosticsBreakdownItem[];
}

export interface LiveStreamContextEstimate {
  sessionId: string;
  assistantMessageId: string;
  version: number;
  baseline?: unknown;
  visibleContent: string;
  visibleContentLength: number;
  hiddenContext?: string;
  providerInputItems?: unknown[];
  providerTurnState?: ProviderTurnState;
  toolTraces: ChatMessage["tool_traces"];
  updatedAt: string;
}

export const EMPTY_CONTEXT_DIAGNOSTICS_COUNTS: ConversationContextDiagnostics["counts"] =
  Object.freeze({
    messages: 0,
    visibleLines: 0,
    hiddenContextLines: 0,
    providerInputItems: 0,
    providerInputItemLines: 0,
    reasoningContentLines: 0,
    toolResultLines: 0,
    citations: 0,
    activeFiles: 0,
    toolFacts: 0,
  });

export const countTextLines = (value: unknown): number => {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).length;
};

export const countStreamContentLines = (
  content: StreamMessage["content"],
): number => {
  if (typeof content === "string") return countTextLines(content);
  return content.reduce((total, part) => {
    if (part.type !== "text") return total;
    return total + countTextLines(part.text);
  }, 0);
};

export const countPreparedToolContextLines = (
  messages: StreamMessage[],
): number =>
  messages.reduce((total, message) => {
    if (typeof message.content !== "string") {
      return total;
    }
    const matches = message.content.matchAll(
      /<tool_context\b[\s\S]*?<\/tool_context>/gi,
    );
    let nextTotal = total;
    for (const match of matches) {
      nextTotal += countTextLines(match[0]);
    }
    return nextTotal;
  }, 0);

export const safeJsonLineCount = (value: unknown): number => {
  try {
    return countTextLines(JSON.stringify(value, null, 2));
  } catch {
    return 0;
  }
};

export const inspectProviderInputValue = (
  value: unknown,
  parentKey = "",
  depth = 0,
): { reasoningLines: number; toolResultLines: number } => {
  if (depth > 8 || value == null) {
    return { reasoningLines: 0, toolResultLines: 0 };
  }

  const normalizedKey = parentKey.toLowerCase();
  if (typeof value === "string") {
    const lines = countTextLines(value);
    if (
      normalizedKey.includes("reasoning") ||
      normalizedKey.includes("thinking")
    ) {
      return { reasoningLines: lines, toolResultLines: 0 };
    }
    if (
      normalizedKey.includes("tool") ||
      normalizedKey.includes("result") ||
      normalizedKey.includes("output")
    ) {
      return { reasoningLines: 0, toolResultLines: lines };
    }
    return { reasoningLines: 0, toolResultLines: 0 };
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => {
        const inspected = inspectProviderInputValue(item, parentKey, depth + 1);
        return {
          reasoningLines: total.reasoningLines + inspected.reasoningLines,
          toolResultLines: total.toolResultLines + inspected.toolResultLines,
        };
      },
      { reasoningLines: 0, toolResultLines: 0 },
    );
  }

  if (typeof value !== "object") {
    return { reasoningLines: 0, toolResultLines: 0 };
  }

  const record = value as Record<string, unknown>;
  const typeHint = String(record.type ?? record.role ?? "").toLowerCase();
  const isToolLike =
    typeHint.includes("tool") ||
    typeHint.includes("function_call_output") ||
    typeHint.includes("function_result");

  return Object.entries(record).reduce(
    (total, [key, child]) => {
      const effectiveKey = isToolLike ? `${parentKey}.${key}.tool_result` : key;
      const inspected = inspectProviderInputValue(child, effectiveKey, depth + 1);
      return {
        reasoningLines: total.reasoningLines + inspected.reasoningLines,
        toolResultLines: total.toolResultLines + inspected.toolResultLines,
      };
    },
    { reasoningLines: 0, toolResultLines: 0 },
  );
};

export const buildContextDiagnosticsFromFootprint = (params: {
  conversationId: string;
  providerId?: string;
  providerType?: string;
  modelId?: string;
  status: ConversationContextDiagnosticsStatus;
  source?: ConversationContextDiagnosticsSource;
  phase?: ConversationCompactionPhase | "provider_error";
  decision?: ContextCompactionDecision;
  compactionPass?: CompactionPass;
  summaryFormatVersion?: number;
  summarySource?: CompactionSummarySource;
  footprintBefore?: ContextFootprint;
  footprintAfter?: ContextFootprint;
  orderedMessages: ChatMessage[];
  preparedMessages: StreamMessage[];
  citations: Citation[];
  compactionState?: ConversationCompactionState | null;
  error?: string;
  repositoryInstructionSources?: RepositoryInstructionDiagnosticSource[];
  repositoryInstructionIssues?: RepositoryInstructionDiagnosticIssue[];
}): ConversationContextDiagnostics => {
  const footprint = params.footprintAfter ?? params.footprintBefore;
  const providerInputItems = params.preparedMessages.flatMap(
    (message) => message.provider_input_items ?? [],
  );
  const providerInputInspection = inspectProviderInputValue(providerInputItems);
  const preparedToolContextLines = countPreparedToolContextLines(
    params.preparedMessages,
  );
  const historicalHiddenContextLines = params.orderedMessages.reduce(
    (total, message) => total + countTextLines(message.hidden_context),
    0,
  );
  const hiddenContextLines =
    preparedToolContextLines > 0
      ? preparedToolContextLines
      : providerInputItems.length > 0
        ? 0
        : historicalHiddenContextLines;
  const visibleLines = params.preparedMessages.reduce(
    (total, message) => total + countStreamContentLines(message.content),
    0,
  );
  const counts: ConversationContextDiagnostics["counts"] = {
    messages: params.orderedMessages.length,
    visibleLines,
    hiddenContextLines,
    providerInputItems: providerInputItems.length,
    providerInputItemLines: safeJsonLineCount(providerInputItems),
    reasoningContentLines: providerInputInspection.reasoningLines,
    toolResultLines:
      providerInputInspection.toolResultLines + hiddenContextLines,
    citations: params.citations.length,
    activeFiles: params.citations.filter(
      (citation) => citation.type === "file" || citation.type === "document",
    ).length,
    toolFacts: params.compactionState?.toolDigest?.length ?? 0,
  };

  const breakdown: ConversationContextDiagnosticsBreakdownItem[] = footprint
    ? [
        {
          id: "serialized_payload",
          label: "Payload sérialisé final",
          tokens: footprint.serializedPayloadTokens,
        },
        {
          id: "visible_messages",
          label: "Messages visibles",
          tokens: footprint.visibleMessageTokens,
          lines: visibleLines,
          count: params.orderedMessages.length,
        },
        {
          id: "provider_input_items",
          label: "Historique provider",
          tokens: footprint.providerInputTokens,
          lines: counts.providerInputItemLines,
          count: counts.providerInputItems,
        },
        {
          id: "hidden_context",
          label: "Contexte masqué / outils",
          tokens: footprint.hiddenContextTokens,
          lines: hiddenContextLines,
        },
        {
          id: "system_prompt",
          label: "Prompt système",
          tokens: footprint.systemTokens,
        },
        {
          id: "tool_schema",
          label: "Schémas d'outils",
          tokens: footprint.toolSchemaTokens,
        },
        {
          id: "citations",
          label: "Citations et sources",
          tokens: footprint.citationTokens,
          count: params.citations.length,
        },
        {
          id: "summary",
          label: "Résumé compacté",
          tokens: footprint.summaryTokens,
          count: params.compactionState ? 1 : 0,
        },
        {
          id: "latest_user",
          label: "Dernier tour utilisateur",
          tokens: footprint.latestUserContextTokens,
        },
      ]
    : [];

  const topContributors = [...breakdown]
    .filter((item) => typeof item.tokens === "number" && item.tokens > 0)
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0))
    .slice(0, 5);

  return {
    status: params.status,
    source: params.source,
    conversationId: params.conversationId,
    updatedAt: new Date().toISOString(),
    providerId: params.providerId,
    providerType: params.providerType,
    modelId: params.modelId,
    modelContextWindowTokens: footprint?.modelContextWindowTokens,
    contextLimitSource: footprint?.contextLimitSource,
    isContextLimitAuthoritative: footprint?.isContextLimitAuthoritative,
    contextLimitConfidence: footprint?.contextLimitConfidence,
    contextLimitWarning: footprint?.contextLimitWarning,
    previousModelContextWindowTokens: footprint?.previousModelContextWindowTokens,
    modelContextWindowShrank: footprint?.modelContextWindowShrank,
    marginTokens: footprint?.marginTokens,
    compactionDecisionAudit: buildContextCompactionDecisionAudit({
      providerId: params.providerId,
      providerType: params.providerType,
      modelId: params.modelId,
      trigger: params.compactionState?.lastTrigger ?? params.compactionState?.compactionKind,
      result: params.decision,
      footprintBefore: params.footprintBefore,
      footprintAfter: params.footprintAfter,
    }),
    phase: params.phase,
    decision: params.decision,
    compactionPass: params.compactionPass,
    summaryFormatVersion: params.summaryFormatVersion,
    summarySource: params.summarySource,
    footprintBefore: params.footprintBefore,
    footprintAfter: params.footprintAfter,
    ratio: Math.max(0, footprint?.totalContextRatio ?? 0),
    usableRatio: Math.max(0, footprint?.usableContextRatio ?? 0),
    isHardStop: Boolean(footprint?.isHardStop),
    error: params.error,
    repositoryInstructionSources: params.repositoryInstructionSources?.map((source) => ({
      ...source,
    })),
    repositoryInstructionIssues: params.repositoryInstructionIssues?.map((issue) => ({
      ...issue,
    })),
    counts,
    breakdown,
    topContributors,
  };
};
