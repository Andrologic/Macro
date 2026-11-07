import { afterAll, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  deliveryValidate as sourceDeliveryValidate,
  resultValidate as sourceResultValidate,
  schemaValidate as sourceSchemaValidate,
} from './macro-pilot-validator-oracle';
import * as shared from '../src/services/macroPilot/schemaValidators';
import { validateA1 } from '../src/services/macroPilot/protocol';
import { checkMacroPilotValidators, generateMacroPilotValidators } from './generate-macro-pilot-validators';

type Validator = (value: unknown) => boolean | Promise<unknown>;
type GeneratedValidators = {
  deliveryValidate: Validator;
  resultValidate: Validator;
  schemaValidate: Validator;
};

const projectRoot = join(import.meta.dir, '..');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'macro-pilot-validators-'));

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

const readFixture = (group: string, file: string): unknown =>
  JSON.parse(
    readFileSync(
      join(projectRoot, 'contracts/macro-pilot/v1/fixtures', group, file),
      'utf8'
    )
  );

describe('generated Macro Pilot validators', () => {
  it('matches source validators while dynamic code execution is blocked', async () => {
    const generatedCode = await generateMacroPilotValidators(projectRoot);
    expect(generatedCode).not.toMatch(/\b(?:eval|Function)\s*\(/);
    expect(generatedCode).not.toContain('compileSchema');

    const modulePath = join(temporaryDirectory, 'validators.mjs');
    writeFileSync(modulePath, generatedCode);

    const fixtures = ['valid', 'invalid'].flatMap((group) =>
      readdirSync(join(projectRoot, 'contracts/macro-pilot/v1/fixtures', group))
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map((file) => readFixture(group, file))
    );
    expect(fixtures).toHaveLength(90);
    const expectedA1 = fixtures.map((fixture) => Boolean(sourceSchemaValidate(fixture)));

    const command = readFixture('valid', 'command.json');
    const commandResult = readFixture('valid', 'command-result.json');
    const actor = (command as { issued_by: unknown }).issued_by;
    const delivery = {
      transport_version: '1.0',
      type: 'delivery',
      exchange_id: 'exchange:generated:test',
      delivery_id: 'delivery:generated:test',
      actor,
      message: command,
    };
    const deliveryResult = {
      transport_version: '1.0',
      type: 'delivery_result',
      exchange_id: delivery.exchange_id,
      delivery_id: delivery.delivery_id,
      message: commandResult,
    };
    const transportCases = [delivery, deliveryResult, { ...delivery, type: 'exchange' }, {
      ...deliveryResult,
      message: command,
    }];
    const expectedDeliveries = transportCases.map((value) => Boolean(sourceDeliveryValidate(value)));
    const expectedResults = transportCases.map((value) => Boolean(sourceResultValidate(value)));

    const originalFunction = globalThis.Function;
    let generatedA1: boolean[];
    let generatedDeliveries: boolean[];
    let generatedResults: boolean[];
    try {
      globalThis.Function = (() => {
        throw new Error('CSP blocked dynamic code execution.');
      }) as unknown as FunctionConstructor;
      const generated = await import(pathToFileURL(modulePath).href) as GeneratedValidators;
      generatedA1 = fixtures.map((fixture) => Boolean(generated.schemaValidate(fixture)));
      generatedDeliveries = transportCases.map((value) => Boolean(generated.deliveryValidate(value)));
      generatedResults = transportCases.map((value) => Boolean(generated.resultValidate(value)));
    } finally {
      globalThis.Function = originalFunction;
    }

    expect(generatedA1).toEqual(expectedA1);
    expect(generatedDeliveries).toEqual(expectedDeliveries);
    expect(generatedResults).toEqual(expectedResults);
  });
});


describe('shared A1 parity and diagnostic ownership', () => {
  it('keeps historical date, URI and unknown-key behavior without treating fixtures as exhaustive', () => {
    const session = readFixture('valid', 'active-device-session.json') as Record<string, any>;
    const account = readFixture('valid', 'account.json') as Record<string, any>;
    const cases = [session, { ...session, issued_at: '2026-10-24T00:00:00.' + '0'.repeat(100_000) + 'Z' },
      { ...session, issued_at: '2026-99-99T00:00:00Z' }, { ...session, unknown: 1 },
      { ...account, identity: { ...account.identity, avatar_url: 'https://example.invalid/a?x=%20' } },
      { ...account, identity: { ...account.identity, avatar_url: 'https://user@example.invalid/a' } },
      { ...account, identity: { ...account.identity, avatar_url: 'not a uri' } },
      { ...account, identity: { ...account.identity, unknown: true } }];
    for (const value of cases) {
      try { expect(Boolean(shared.schemaValidate(value))).toBe(Boolean(sourceSchemaValidate(value))); }
      finally { shared.clearErrors(); }
      expect(shared.diagnosticsEmpty()).toBe(true);
    }
    expect(validateA1(cases[1])).toBe(true);
    // This rule belongs to protocol.ts, beyond schema generation.
    const semantic = readFixture('invalid', 'cross-account-session-revoke.json');
    expect(shared.schemaValidate(semantic)).toBe(true);
    expect(validateA1(semantic)).toBe(false);
    shared.clearErrors();
  });
  it('clears the actual generated diagnostic owners after refusal and exceptions', () => {
    expect(shared.schemaValidate({ type: 'device_session' })).toBe(false);
    expect(shared.diagnosticsEmpty()).toBe(false);
    try {
      shared.schemaValidate(new Proxy({}, { get() { throw new Error('synthetic getter'); } }));
      throw new Error('validator did not read the object');
    } catch (error) {
      expect((error as Error).message).toBe('synthetic getter');
    } finally { shared.clearErrors(); }
    expect(shared.diagnosticsEmpty()).toBe(true);
  });
});


describe('A1 transitive profile identity', () => {
  it('refuses stale bootstrap owners before Connect can write derived attestations', async () => {
    await checkMacroPilotValidators(projectRoot);
    const root = join(temporaryDirectory, 'profile-identity');
    const manifest = JSON.parse(readFileSync(join(projectRoot, 'src/services/macroPilot/schemaValidators.identity.json'), 'utf8'));
    const generated = [
      'copilot-bridge/src/connect-transfer-identities.generated.ts',
      'copilot-bridge/src/connect-codec.identity.json',
      'copilot-bridge/src/connect-bootstrap.identity.json',
    ];
    const paths = new Set<string>([
      ...manifest.resources.map((entry: { path: string }) => entry.path),
      'src/services/macroPilot/schemaValidators.identity.json',
      'dev/generate-connect-transfer-identities.mjs', ...generated,
    ]);
    for (const path of paths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(projectRoot, path), join(root, path));
    }
    symlinkSync(join(projectRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    await checkMacroPilotValidators(root);
    for (const path of [
      'copilot-bridge/src/connect-bootstrap.ts',
      'copilot-bridge/src/connect-bootstrap-operations.ts',
      'copilot-bridge/src/connect-codec-engine.ts',
    ]) {
      expect(manifest.resources.some((entry: { path: string }) => entry.path === path)).toBe(true);
      const original = readFileSync(join(root, path), 'utf8');
      writeFileSync(join(root, path), original + '\n// Synthetic transitive source change.\n');
      await expect(checkMacroPilotValidators(root)).rejects.toThrow('Stale Macro Pilot validator: schemaValidators.identity.json');
      for (const suffix of [[], ['--check']]) {
        const result = Bun.spawnSync([process.execPath, join(root, 'dev/generate-connect-transfer-identities.mjs'), ...suffix], { cwd: root });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain('Stale Macro Pilot validator: schemaValidators.identity.json');
        for (const target of generated) expect(readFileSync(join(root, target))).toEqual(readFileSync(join(projectRoot, target)));
      }
      writeFileSync(join(root, path), original);
    }
    await checkMacroPilotValidators(root);
  });
});
