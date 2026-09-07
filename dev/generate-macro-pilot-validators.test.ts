import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  deliveryValidate as sourceDeliveryValidate,
  resultValidate as sourceResultValidate,
  schemaValidate as sourceSchemaValidate,
} from '../src/services/macroPilot/schemaValidators';
import { generateMacroPilotValidators } from './generate-macro-pilot-validators';

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
