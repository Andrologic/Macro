export interface ServiceError {
  code: string;
  message: string;
  details?: unknown;
}

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
