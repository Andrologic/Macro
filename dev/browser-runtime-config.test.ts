import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateQaBrowserRuntimeConfig } from './browser-runtime-config.mjs';

test('requires an isolated identifier and the browser RPC capability', () => {
  const config = {
    identifier: 'com.macro.desktop.qa.lot-h-123456',
    app: { security: { capabilities: [{ permissions: ['tauri-remote-ui:allow-complete-rpc'] }] } },
  };
  expect(validateQaBrowserRuntimeConfig(config)).toBe(config);
  expect(() => validateQaBrowserRuntimeConfig({ ...config, identifier: 'com.macro.desktop' }))
    .toThrow('isolated');
  expect(() => validateQaBrowserRuntimeConfig({
    identifier: config.identifier,
    app: { security: { capabilities: [] } },
  })).toThrow('debug RPC');
});

test('the default browser runtime config is isolated from the production profile', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.browser-debug.conf.json', 'utf8'));
  expect(validateQaBrowserRuntimeConfig(config)).toBe(config);
});
