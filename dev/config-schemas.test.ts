import { expect, test } from 'bun:test';
import Ajv from 'ajv';
import toolsSchema from '../src-tauri/config-schemas/v1/tools.schema.json';

test('the v1 Tools schema accepts the ignored language server field in older profiles', () => {
  const validate = new Ajv({ strict: false, formats: { uint32: true } }).compile(toolsSchema);
  const profile = { $schema: './schemas/v1/tools.schema.json', schemaVersion: 1, riskLevel: 'strict' };
  const languageServer = {
    enabled: true,
    executable: '/example/language-server',
    arguments: ['--stdio'],
    workspaceRoots: ['/example/workspace'],
    waitMs: 4000,
  };

  expect(validate(profile)).toBe(true);
  expect(validate({ ...profile, languageServer })).toBe(true);
  expect(validate({ ...profile, languageServer: null })).toBe(true);
  expect(validate({ ...profile, languageServer, unknownSetting: true })).toBe(false);
});
