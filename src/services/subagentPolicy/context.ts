import type {
  DelegationContext,
  DelegationContextInput,
  DelegationError,
  DelegationRelevantArea,
  DelegationResult,
} from "./types";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const normalizeList = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const entry = normalizeText(value);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
  }
  return normalized;
};

const normalizeAreas = (
  areas: readonly DelegationRelevantArea[]
): DelegationRelevantArea[] => {
  const seen = new Set<string>();
  const normalized: DelegationRelevantArea[] = [];
  for (const area of areas) {
    const path = area.path.trim();
    const reason = area.reason ? normalizeText(area.reason) : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push(reason ? { path, reason } : { path });
  }
  return normalized;
};

export const serializeDelegationContext = (context: DelegationContext): string =>
  JSON.stringify({
    objective: context.objective,
    successCriteria: context.successCriteria,
    relevantAreas: context.relevantAreas,
    constraints: context.constraints,
    establishedFacts: context.establishedFacts,
    responseFormat: context.responseFormat,
  });

export const getDelegationContextSize = (context: DelegationContext): number =>
  utf8Bytes(serializeDelegationContext(context));

export const buildDelegationContext = (
  input: DelegationContextInput,
  maxContextBytes?: number
): DelegationResult<DelegationContext> => {
  const objective = normalizeText(input.objective);
  const successCriteria = normalizeList(input.successCriteria);
  const responseFormat = normalizeText(input.responseFormat);
  const errors: DelegationError[] = [];

  if (!objective) {
    errors.push({
      code: "invalid_context",
      path: "objective",
      message: "Expected a non-empty objective.",
    });
  }
  if (successCriteria.length === 0) {
    errors.push({
      code: "invalid_context",
      path: "successCriteria",
      message: "Expected at least one success criterion.",
    });
  }
  if (!responseFormat) {
    errors.push({
      code: "invalid_context",
      path: "responseFormat",
      message: "Expected a non-empty response format.",
    });
  }
  if (maxContextBytes !== undefined && (!Number.isInteger(maxContextBytes) || maxContextBytes <= 0)) {
    errors.push({
      code: "invalid_context",
      path: "maxContextBytes",
      message: "Expected a positive integer.",
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const context: DelegationContext = {
    objective,
    successCriteria,
    relevantAreas: normalizeAreas(input.relevantAreas ?? []),
    constraints: normalizeList(input.constraints ?? []),
    establishedFacts: normalizeList(input.establishedFacts ?? []),
    responseFormat,
  };
  const size = getDelegationContextSize(context);
  if (maxContextBytes !== undefined && size > maxContextBytes) {
    return {
      ok: false,
      errors: [
        {
          code: "context_too_large",
          path: "$",
          message: `Delegation context is ${size} bytes; limit is ${maxContextBytes}.`,
          details: { actualBytes: size, maxContextBytes },
        },
      ],
    };
  }

  return { ok: true, value: context };
};
