// Browser bundle declarations. Regenerate implementation with the matching dev script.
export type ContentValidation = { valid: boolean; errors: unknown[] };
export function validateMessage(value: unknown): ContentValidation;
export function validateExchange(request: unknown, response: unknown): ContentValidation;
export function validatePageContinuation(previous: unknown, next: unknown): ContentValidation;

export function validateResourceIntegrity(message: unknown): Promise<ContentValidation>;
export function validateCapturedFileBytes(capture: unknown, raw: Uint8Array): Promise<boolean>;
