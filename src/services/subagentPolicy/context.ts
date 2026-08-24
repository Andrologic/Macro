import type {
  DelegationContext,
  DelegationContextInput,
  DelegationError,
  DelegationRelevantArea,
  DelegationResult,
} from "./types";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readTextList = (
  value: unknown,
  path: string,
  errors: DelegationError[],
  required: boolean
): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    errors.push({
      code: "invalid_context",
      path,
      message: required
        ? "Expected at least one success criterion."
        : "Expected an array of strings.",
    });
    return [];
  }

  const normalized = normalizeList(value);
  if (required && normalized.length === 0) {
    errors.push({
      code: "invalid_context",
      path,
      message: "Expected at least one success criterion.",
    });
  }
  return normalized;
};

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
  const errors: DelegationError[] = [];
  const candidate: Record<string, unknown> = isRecord(input) ? input : {};
  const objective =
    typeof candidate.objective === "string" ? normalizeText(candidate.objective) : "";
  const responseFormat =
    typeof candidate.responseFormat === "string"
      ? normalizeText(candidate.responseFormat)
      : "";

  if (!objective) {
    errors.push({
      code: "invalid_context",
      path: "objective",
      message: "Expected a non-empty objective.",
    });
  }
  const successCriteria = readTextList(
    candidate.successCriteria,
    "successCriteria",
    errors,
    true
  );
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

  const constraints = readTextList(candidate.constraints ?? [], "constraints", errors, false);
  const establishedFacts = readTextList(
    candidate.establishedFacts ?? [],
    "establishedFacts",
    errors,
    false
  );
  const relevantAreasInput = candidate.relevantAreas ?? [];
  if (
    !Array.isArray(relevantAreasInput) ||
    relevantAreasInput.some(
      (area) =>
        !isRecord(area) ||
        typeof area.path !== "string" ||
        (area.reason !== undefined && typeof area.reason !== "string")
    )
  ) {
    errors.push({
      code: "invalid_context",
      path: "relevantAreas",
      message: "Expected an array of areas with a string path and optional string reason.",
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const context: DelegationContext = {
    objective,
    successCriteria,
    relevantAreas: normalizeAreas(relevantAreasInput as DelegationRelevantArea[]),
    constraints,
    establishedFacts,
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
