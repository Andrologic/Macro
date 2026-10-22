import { describe, expect, it } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { validateContentMessage, validateContentResponse, type ContentNegotiated } from './contentProtocol';

const contract = new URL('../../../contracts/macro-pilot/v2/', import.meta.url);
const load = async <T = unknown>(name: string): Promise<T> =>
  JSON.parse(await readFile(new URL(`fixtures/valid/${name}.json`, contract), 'utf8')) as T;
type PublicValidator = {
  validateMessage(value: unknown): { valid: boolean };
  validateExchange(request: unknown, response: unknown): { valid: boolean };
};
const canonical: PublicValidator = await import(new URL('validate.mjs', contract).href);

// These checks establish the wire contract, never authenticated freshness.
describe('bounded read-authority wire proof', () => {
  it('keeps canonical and browser validation identical for every public fixture', async () => {
    for (const group of ['valid', 'invalid']) {
      for (const name of await readdir(new URL(`fixtures/${group}/`, contract))) {
        const value: unknown = JSON.parse(await readFile(new URL(`fixtures/${group}/${name}`, contract), 'utf8'));
        expect(canonical.validateMessage(value).valid, `${group}/${name}`).toBe(group === 'valid');
        expect(validateContentMessage(value), `${group}/${name}`).toBe(canonical.validateMessage(value).valid);
      }
    }
  });

  it('correlates the selected capability, exact instance, version and attempt', async () => {
    const request = await load<Record<string, unknown>>('read-authority-negotiate');
    const response = await load('read-authority-negotiated');
    expect(validateContentResponse(await load('read-authority-all-negotiate'), await load('read-authority-all-negotiated'))).toBe(true);
    for (const check of [canonical.validateExchange, (a: unknown, b: unknown) => ({ valid: validateContentResponse(a, b) })]) {
      expect(check(request, response).valid).toBe(true);
      for (const replacement of [
        { request_id: 'another-attempt' }, { instance_id: 'another-instance' },
        { capabilities: [] }, { supported_versions: ['1.0'] }, { instance_id: undefined },
      ]) expect(check({ ...request, ...replacement }, response).valid).toBe(false);
      // A peer may omit the optional capability, without granting offline display.
      const legacy = await load<Record<string, unknown>>('negotiated');
      expect(check(request, legacy).valid).toBe(true);
    }
  });

  it('enforces a positive maximum 30-second duration across offsets and millisecond boundaries', async () => {
    const response = await load<ContentNegotiated>('read-authority-negotiated');
    if (!response.read_authority) throw new Error('fixture must contain read authority');
    const proof = response.read_authority;
    for (const [issuedAt, expiresAt, valid] of [
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.001Z', true],
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z', true],
      ['2026-01-01T00:00:00.01Z', '2026-01-01T00:00:30.01Z', true],
      ['2026-01-01T00:00:00.0001Z', '2026-01-01T00:00:30.0009Z', false],
      ['2026-01-01T00:00:00.0000Z', '2026-01-01T00:00:30.0001Z', false],
      ['2026-01-01T00:00:00.0000Z', '2026-01-01T00:00:00.0001Z', false],
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z', true],
      ['2026-01-01T01:00:00.000+01:00', '2026-01-01T00:00:30.000Z', true],
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.001Z', false],
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', false],
      ['2026-01-01T00:00:00.001Z', '2026-01-01T00:00:00.000Z', false],
    ] as const) {
      const value = { ...response, read_authority: { ...proof, issued_at: issuedAt, expires_at: expiresAt } };
      expect(canonical.validateMessage(value).valid).toBe(valid);
      expect(validateContentMessage(value)).toBe(valid);
    }
  });

  it('deliberately leaves trusted audience and current-time checks to stateful consumers', async () => {
    const response = await load<ContentNegotiated>('read-authority-negotiated');
    if (!response.read_authority) throw new Error('fixture must contain read authority');
    // Old timestamps and a different syntactically valid audience stay shape-valid.
    // Runtime clients must reject them using their own session and monotonic deadline.
    const value = { ...response, read_authority: { ...response.read_authority, account_id: 'different-account' } };
    expect(canonical.validateMessage(value).valid).toBe(true);
    expect(validateContentMessage(value)).toBe(true);
  });
});
