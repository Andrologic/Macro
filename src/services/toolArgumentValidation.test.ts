import { describe, expect, it } from 'bun:test';
import { requireMacroToolRegistryEntry } from '../shared/macroToolRegistry';
import {
  formatToolArgumentValidationError,
  validateToolArguments,
} from './toolArgumentValidation';

describe('tool argument validation', () => {
  it('rejects a missing required citation before executing edit_source_passage', () => {
    const schema = requireMacroToolRegistryEntry('edit_source_passage').parameters;
    const issues = validateToolArguments({ action: 'reclassify' }, schema);

    expect(issues).toEqual([
      { path: '$.citation_id', message: 'required value is missing' },
    ]);
    expect(formatToolArgumentValidationError('edit_source_passage', issues)).toContain(
      '$.citation_id required value is missing',
    );
  });

  it('rejects wrong types and enum values', () => {
    const schema = requireMacroToolRegistryEntry('edit_source_passage').parameters;
    const issues = validateToolArguments(
      { citation_id: 42, action: 'rename' },
      schema,
    );

    expect(issues).toEqual([
      { path: '$.citation_id', message: 'expected string, received number' },
      {
        path: '$.action',
        message: 'expected one of: update, reclassify, delete',
      },
    ]);
  });

  it('allows empty required file content and replacement text', () => {
    const writeIssues = validateToolArguments(
      { path: 'empty.txt', content: '' },
      requireMacroToolRegistryEntry('write').parameters,
    );
    const editIssues = validateToolArguments(
      { path: 'file.txt', old_text: 'remove me', new_text: '' },
      requireMacroToolRegistryEntry('edit').parameters,
    );

    expect(writeIssues).toEqual([]);
    expect(editIssues).toEqual([]);
  });

  it('reports an empty required identifier once', () => {
    const issues = validateToolArguments(
      { citation_id: '', action: 'reclassify' },
      requireMacroToolRegistryEntry('edit_source_passage').parameters,
    );

    expect(issues).toEqual([{ path: '$.citation_id', message: 'required value is missing' }]);
  });

  it('rejects empty required queries, URLs, paths, and search patterns', () => {
    for (const [toolName, args] of [
      ['web_search', { query: '' }],
      ['web_fetch', { url: '' }],
      ['read', { path: '' }],
      ['write', { path: '', content: '' }],
      ['edit', { path: '', old_text: '', new_text: '' }],
      ['glob', { pattern: '' }],
      ['grep', { query: '' }],
    ] as const) {
      expect(
        validateToolArguments(args, requireMacroToolRegistryEntry(toolName).parameters),
      ).not.toEqual([]);
    }
  });

  it('rejects whitespace-only required identifiers and commands by default', () => {
    for (const [toolName, args] of [
      ['git_checkout', { branch_or_commit: '   ' }],
      ['git_merge', { branch_name: ' ', into_branch: 'develop' }],
      ['terminal_run', { session_id: 'session', command: '\t' }],
      ['plan_get', { plan_id: '  ' }],
    ] as const) {
      expect(
        validateToolArguments(args, requireMacroToolRegistryEntry(toolName).parameters),
      ).not.toEqual([]);
    }
  });
});
