import { describe, expect, it } from 'bun:test';
import { normalizeLegacyToolExecutionResult } from './toolResultNormalization';

describe('legacy tool result normalization', () => {
  it('classifies only known legacy errors for their producing tool', () => {
    const result = normalizeLegacyToolExecutionResult(
      'read_file',
      '[macro_scope_promotion] {"promoted_project_ids":["project"]}\nFile not found: missing.txt',
    );
    expect(result).toMatchObject({ isError: true, errorKind: 'execution' });
  });

  it('does not reinterpret successful terminal or MCP output as an error', () => {
    expect(normalizeLegacyToolExecutionResult('terminal_run', 'Cannot reproduce the issue.')).toBe(
      'Cannot reproduce the issue.',
    );
    expect(normalizeLegacyToolExecutionResult('mcp__docs__read', 'File not found: an example')).toBe(
      'File not found: an example',
    );
  });
});
