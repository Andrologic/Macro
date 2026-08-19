import { describe, expect, test } from 'bun:test';
import { validateWorkflowDocument, validateWorkflows } from './validate-workflows.mjs';

describe('GitHub workflow validation', () => {
  test('current workflows satisfy repository policy', () => {
    expect(validateWorkflows()).toEqual([]);
  });

  test('rejects unpinned actions and missing timeouts', () => {
    const errors = validateWorkflowDocument({
      name: 'Unsafe',
      on: { push: { branches: ['develop'] } },
      permissions: { contents: 'read' },
      jobs: {
        validate: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: 'actions/checkout@v4' }],
        },
      },
    }, '.github/workflows/unsafe.yml');

    expect(errors.some((error) => error.includes('timeout-minutes'))).toBe(true);
    expect(errors.some((error) => error.includes('full commit SHA'))).toBe(true);
  });

  test('rejects pull_request_target', () => {
    const errors = validateWorkflowDocument({
      name: 'Unsafe',
      on: { pull_request_target: {} },
      permissions: { contents: 'read' },
      jobs: {},
    }, '.github/workflows/unsafe.yml');

    expect(errors.some((error) => error.includes('pull_request_target'))).toBe(true);
  });
});
