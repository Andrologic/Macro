export interface ServiceError {
  code: string;
  message: string;
  details?: unknown;
}

export const SERVICE_ERROR_CODES = {
  PLAN_METADATA_MISSING: 'PLAN_METADATA_MISSING',
  PLAN_REPLICA_DIVERGED: 'PLAN_REPLICA_DIVERGED',
  RESOURCE_PRESSURE: 'RESOURCE_PRESSURE',
  WORKSPACE_STATE_UNAVAILABLE: 'WORKSPACE_STATE_UNAVAILABLE',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;

export type ServiceErrorCode =
  (typeof SERVICE_ERROR_CODES)[keyof typeof SERVICE_ERROR_CODES];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isServiceError = (value: unknown): value is ServiceError => {
  if (!isRecord(value)) return false;
  return (
    'code' in value &&
    'message' in value &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
};

const readNestedString = (value: Record<string, unknown>, key: string): string | null => {
  const direct = value[key];
  if (typeof direct === 'string' && direct.trim()) {
    return direct;
  }

  const nested = value.data;
  if (isRecord(nested)) {
    const nestedValue = nested[key];
    if (typeof nestedValue === 'string' && nestedValue.trim()) {
      return nestedValue;
    }
  }

  return null;
};

export const toServiceError = (error: unknown): ServiceError => {
  if (isServiceError(error)) return error;
  if (typeof error === 'string') {
    return { code: 'UNEXPECTED_ERROR', message: error, details: error };
  }
  if (isRecord(error)) {
    const code =
      readNestedString(error, 'code') ||
      readNestedString(error, 'kind') ||
      'UNEXPECTED_ERROR';
    const message =
      readNestedString(error, 'message') ||
      readNestedString(error, 'error') ||
      readNestedString(error, 'reason') ||
      readNestedString(error, '0') ||
      (typeof error.details === 'string' ? error.details : null) ||
      (typeof error.cause === 'string' ? error.cause : null) ||
      null;

    if (message) {
      return {
        code,
        message,
        details: error,
      };
    }
  }
  if (error instanceof Error) {
    return { code: 'UNEXPECTED_ERROR', message: error.message, details: error.stack };
  }
  return { code: 'UNEXPECTED_ERROR', message: 'Unknown error', details: error };
};

export class MacroServiceError extends Error implements ServiceError {
  readonly code: ServiceErrorCode | string;
  readonly details?: unknown;

  constructor(code: ServiceErrorCode | string, message: string, details?: unknown) {
    super(message);
    this.name = 'MacroServiceError';
    this.code = code;
    this.details = details;
  }
}

export const createServiceError = (
  code: ServiceErrorCode | string,
  message: string,
  details?: unknown
): ServiceError => ({
  code,
  message,
  ...(details === undefined ? {} : { details }),
});

export const createPlanMetadataMissingError = (params: {
  planId: string;
  branchName?: string | null;
  reason?: string | null;
  details?: unknown;
}): MacroServiceError =>
  new MacroServiceError(
    SERVICE_ERROR_CODES.PLAN_METADATA_MISSING,
    `Plan not found: ${params.planId}`,
    {
      planId: params.planId,
      branchName: params.branchName ?? null,
      reason: params.reason ?? 'plan_metadata_missing',
      ...(params.details === undefined ? {} : { details: params.details }),
    }
  );

export const isPlanMetadataMissingError = (error: unknown): boolean => {
  const normalized = toServiceError(error);
  const message = normalized.message.toLowerCase();
  return (
    normalized.code === SERVICE_ERROR_CODES.PLAN_METADATA_MISSING ||
    message.includes('plan not found') ||
    (message.includes('plan') && message.includes('metadata') && message.includes('missing'))
  );
};

export const isResourcePressureError = (error: unknown): boolean => {
  const normalized = toServiceError(error);
  const message = normalized.message.toLowerCase();
  return (
    normalized.code === SERVICE_ERROR_CODES.RESOURCE_PRESSURE ||
    message.includes('too many open files') ||
    message.includes('os error 24') ||
    message.includes('emfile')
  );
};

export const isWorkspaceStateUnavailableError = (error: unknown): boolean => {
  const normalized = toServiceError(error);
  const message = normalized.message.toLowerCase();
  return (
    normalized.code === SERVICE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE ||
    (message.includes('failed to read workspace state') && !isResourcePressureError(error))
  );
};
