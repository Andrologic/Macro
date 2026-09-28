import { describe, expect, it } from 'bun:test';
import type { McpElicitationPrompt } from '../../types/generated/ipc';
import { initialFormDraft, parseFormPrompt, validateFormDraft } from './formElicitation';

const prompt = (schema: Record<string, unknown>, message = 'Review these values'): McpElicitationPrompt => ({
  id: 'form-1',
  request: { method: 'elicitation/create', params: { mode: 'form', message, requestedSchema: schema } } as McpElicitationPrompt['request'],
});

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Display name', minLength: 2, maxLength: 12, default: 'Ada' },
    role: { type: 'string', oneOf: [{ const: 'reader', title: 'Reader' }, { const: 'writer', title: 'Writer' }] },
    tags: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, minItems: 2, maxItems: 2 },
    age: { type: 'integer', minimum: 18, maximum: 120 },
    enabled: { type: 'boolean', default: false },
    contact: { type: 'string', format: 'email' },
  },
  required: ['name', 'role', 'tags'],
};

describe('MCP form presentation contract', () => {
  it('preserves labels, defaults, order and supported constraints', () => {
    const form = parseFormPrompt(prompt(schema));
    expect(form?.fields.map((field) => field.name)).toEqual(['name', 'role', 'tags', 'age', 'enabled', 'contact']);
    expect(form?.fields[1]?.choices).toEqual([
      { value: 'reader', label: 'Reader' }, { value: 'writer', label: 'Writer' },
    ]);
    expect(initialFormDraft(form!)).toEqual({ name: 'Ada', enabled: 'false' });
    const accepted = validateFormDraft(form!, {
      name: 'Grace', role: 'writer', tags: ['a', 'b'], age: '25.0', enabled: 'true', contact: 'user@example.com',
    });
    expect(accepted).toEqual({
      content: { name: 'Grace', role: 'writer', tags: ['a', 'b'], age: 25, enabled: true, contact: 'user@example.com' },
      errors: {},
    });
  });

  it('rejects invalid draft values before review while Rust remains authoritative', () => {
    const form = parseFormPrompt(prompt(schema))!;
    const result = validateFormDraft(form, {
      name: 'A', role: 'admin', tags: ['a', 'a'], age: '17', contact: 'not-an-email',
    });
    expect(result.content).toBeNull();
    expect(result.errors).toEqual({
      name: 'minimum', role: 'choice', tags: 'duplicate', age: 'minimum', contact: 'invalid',
    });
    expect(validateFormDraft(form, { name: 'Ada', role: 'reader', tags: ['a', 'b'],
      contact: 'user@-example.com' }).errors.contact).toBe('invalid');
    const timed = parseFormPrompt(prompt({ type: 'object', properties: {
      when: { type: 'string', format: 'date-time' },
    }, required: ['when'] }))!;
    expect(validateFormDraft(timed, { when: '2026-02-30T12:00:00Z' }).errors.when).toBe('invalid');
    expect(validateFormDraft(timed, { when: '2026-02-28T12:00:00Z' }).content).toEqual({ when: '2026-02-28T12:00:00Z' });
  });

  it('fails closed for unsupported schema and flags credential requests without rendering fields', () => {
    expect(parseFormPrompt(prompt({ type: 'object', properties: { nested: { type: 'object' } } }))).toBeNull();
    expect(parseFormPrompt(prompt({ type: 'object', properties: { key: { type: 'string', pattern: '.+' } } }))).toBeNull();
    expect(parseFormPrompt(prompt({ type: 'object', properties: { api_key: { type: 'string' } } }))?.blockedForSecrets).toBe(true);
    expect(parseFormPrompt(prompt({ type: 'object', properties: { pin: { type: 'string', title: 'PIN' } } }, 'Enter the one-time code'))?.blockedForSecrets).toBe(true);
    expect(parseFormPrompt(prompt({ type: 'object', properties: { otp: { type: 'integer' } } }, 'Verification code'))?.blockedForSecrets).toBe(true);
    for (const name of ['pin_code', 'pinCode', 'PINCode', 'PINCODE', 'otp_code', 'otpCode', 'otpValue']) {
      expect(parseFormPrompt(prompt({ type: 'object', properties: { [name]: { type: 'string', title: 'Entry' } } }, 'Enter the code'))?.blockedForSecrets).toBe(true);
    }
    expect(parseFormPrompt(prompt({ type: 'object', properties: {} }, 'Enter your password'))?.blockedForSecrets).toBe(true);
  });
});
