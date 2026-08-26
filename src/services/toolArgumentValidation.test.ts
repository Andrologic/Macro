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
});
