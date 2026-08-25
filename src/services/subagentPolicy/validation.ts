import {
  AGENT_CAPABILITIES,
  type AgentCapability,
  type AgentDefinition,
  type DelegationError,
  type DelegationLimits,
  type DelegationResult,
} from "./types";
import { normalizeReasoningEffortValue } from "../reasoningCatalog";

const CAPABILITY_SET = new Set<string>(AGENT_CAPABILITIES);

const error = (
  code: DelegationError["code"],
  path: string,
  message: string
): DelegationError => ({ code, path, message });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;

const validateRequiredText = (
  value: unknown,
  path: string,
  errors: DelegationError[]
): value is string => {
  if (typeof value === "string" && value.trim().length > 0) return true;
  errors.push(error("invalid_agent_definition", path, "Expected a non-empty string."));
  return false;
};

const validatePositiveLimit = (
  limits: Record<string, unknown>,
  name: keyof DelegationLimits,
  required: boolean,
  errors: DelegationError[]
): void => {
  const value = limits[name];
  if (!required && value === undefined) return;
  if (!isPositiveInteger(value)) {
    errors.push(
      error(
        "invalid_agent_definition",
        `limits.${name}`,
        "Expected a positive integer."
      )
    );
  }
};

export const validateAgentDefinition = (
  input: unknown
): DelegationResult<AgentDefinition> => {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        error("invalid_agent_definition", "$", "Expected an agent definition object."),
      ],
    };
  }

  const errors: DelegationError[] = [];
  validateRequiredText(input.id, "id", errors);
  validateRequiredText(input.role, "role", errors);
  validateRequiredText(input.description, "description", errors);

  if (input.model !== undefined) validateRequiredText(input.model, "model", errors);
  if (input.effort !== undefined && normalizeReasoningEffortValue(input.effort) === null) {
    errors.push(
      error("invalid_agent_definition", "effort", "Expected a supported reasoning effort.")
    );
  }

  if (!Array.isArray(input.capabilities)) {
    errors.push(
      error("invalid_agent_definition", "capabilities", "Expected an array of capabilities.")
    );
  } else {
    input.capabilities.forEach((capability, index) => {
      if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) {
        errors.push(
          error(
            "invalid_agent_definition",
            `capabilities[${index}]`,
            "Unknown agent capability."
          )
        );
      }
    });
  }

  if (
    !Array.isArray(input.limitations) ||
    input.limitations.some((value) => typeof value !== "string" || value.trim().length === 0)
  ) {
    errors.push(
      error(
        "invalid_agent_definition",
        "limitations",
        "Expected an array of non-empty strings."
      )
    );
  }

  if (!isRecord(input.limits)) {
    errors.push(error("invalid_agent_definition", "limits", "Expected a limits object."));
  } else {
    validatePositiveLimit(input.limits, "maxChildDepth", true, errors);
    validatePositiveLimit(input.limits, "maxConcurrencyPerParent", true, errors);
    validatePositiveLimit(input.limits, "maxContextBytes", true, errors);
    validatePositiveLimit(input.limits, "maxTurns", false, errors);
    validatePositiveLimit(input.limits, "maxTokens", false, errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AgentDefinition };
};

export const normalizeCapabilities = (
  capabilities: readonly AgentCapability[]
): AgentCapability[] =>
  AGENT_CAPABILITIES.filter((capability) => capabilities.includes(capability));
