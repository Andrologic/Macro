import { describe, expect, it } from 'bun:test';
import {
  SERVICE_ERROR_CODES,
  createPlanMetadataMissingError,
  isPlanMetadataMissingError,
  isGitObjectMissingError,
  isReviewSuspendingError,
  isResourcePressureError,
  toServiceError,
} from './errors';

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

  it('extracts stable backend validation errors', () => {
    const result = toServiceError({
      code: 'Validation',
      message: 'Staged files outside this task were found: src/extra.ts.',
    });

    expect(result.code).toBe('Validation');
    expect(result.message).toBe('Staged files outside this task were found: src/extra.ts.');
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

  it('creates typed plan metadata missing errors while keeping the legacy message', () => {
    const error = createPlanMetadataMissingError({
      branchName: 'develop',
      planId: 'plan-1',
    });

    expect(error.code).toBe(SERVICE_ERROR_CODES.PLAN_METADATA_MISSING);
    expect(error.message).toBe('Plan not found: plan-1');
    expect(isPlanMetadataMissingError(error)).toBe(true);
  });

  it('classifies resource pressure messages and typed errors', () => {
    expect(isResourcePressureError('Too many open files (os error 24)')).toBe(true);
    expect(
      isResourcePressureError({
        code: SERVICE_ERROR_CODES.RESOURCE_PRESSURE,
        message: 'workspace refresh paused',
      })
    ).toBe(true);
  });

  it('classifies missing Git objects by stable code only', () => {
    expect(isGitObjectMissingError({
      code: SERVICE_ERROR_CODES.GIT_OBJECT_MISSING,
      message: 'missing',
    })).toBe(true);
    expect(isGitObjectMissingError('object not found')).toBe(false);
  });

  it('suspends review for checkpoint and direct-mode errors by stable code', () => {
    for (const code of [
      SERVICE_ERROR_CODES.GIT_OBJECT_MISSING,
      SERVICE_ERROR_CODES.DIRECT_CHECKPOINT_MISSING,
      SERVICE_ERROR_CODES.DIRECT_CHECKPOINT_CORRUPT,
      SERVICE_ERROR_CODES.DIRECT_CHECKPOINT_PROJECT_MISMATCH,
      SERVICE_ERROR_CODES.DIRECT_MODE_CONFIGURATION_REQUIRED,
    ]) {
      expect(isReviewSuspendingError({ code, message: 'blocked' })).toBe(true);
    }
    expect(isReviewSuspendingError('object not found')).toBe(false);
  });
});
