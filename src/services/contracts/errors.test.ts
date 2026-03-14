import { describe, expect, it } from 'bun:test';
import { toServiceError } from './errors';

describe('toServiceError', () => {
  it('normalizes string errors', () => {
    expect(toServiceError('Command not found')).toEqual({
      code: 'UNEXPECTED_ERROR',
      message: 'Command not found',
      details: 'Command not found',
    });
  });

  it('extracts tuple-like tauri validation errors', () => {
    const result = toServiceError({
      code: 'Validation',
      0: 'Unknown project group id: group-123',
    });

    expect(result.code).toBe('Validation');
    expect(result.message).toBe('Unknown project group id: group-123');
  });

  it('extracts nested invoke error payloads', () => {
    const result = toServiceError({
      kind: 'InvokeError',
      data: {
        code: 'Validation',
        message: 'Unknown project id: project-123',
      },
    });

    expect(result.code).toBe('Validation');
    expect(result.message).toBe('Unknown project id: project-123');
  });
});
