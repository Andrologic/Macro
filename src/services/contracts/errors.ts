export interface ServiceError {
  code: string;
  message: string;
  details?: unknown;
}

export const isServiceError = (value: unknown): value is ServiceError => {
  if (!value || typeof value !== 'object') return false;
  return (
    'code' in value &&
    'message' in value &&
    typeof (value as ServiceError).code === 'string' &&
    typeof (value as ServiceError).message === 'string'
  );
};

export const toServiceError = (error: unknown): ServiceError => {
  if (isServiceError(error)) return error;
  if (error instanceof Error) {
    return { code: 'UNEXPECTED_ERROR', message: error.message, details: error.stack };
  }
  return { code: 'UNEXPECTED_ERROR', message: 'Unknown error', details: error };
};
