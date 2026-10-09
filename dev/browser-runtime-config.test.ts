import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveQaBrowserLogDirectory,
  resolveQaBrowserPorts,
  validateQaBrowserRuntimeConfig,
} from './browser-runtime-config.mjs';

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
  const logDirectory = resolveQaBrowserLogDirectory(config, '/tmp');
  expect(logDirectory).toBe(join(
    '/tmp',
    'macro-browser-runtime',
    'com.macro.desktop.qa.browser',
    'logs',
  ));
  expect(logDirectory).not.toBe(join('/tmp', 'com.macro.desktop', 'logs'));
});

test('allocates separate loopback UI and bridge ports without weakening origin checks', () => {
  expect(resolveQaBrowserPorts({})).toEqual({ ui: 1422, bridge: 1430, origin: 'http://127.0.0.1:1422' });
  expect(resolveQaBrowserPorts({ MACRO_TAURI_BROWSER_UI_PORT: '1426', MACRO_TAURI_BROWSER_BRIDGE_PORT: '1436' }))
    .toEqual({ ui: 1426, bridge: 1436, origin: 'http://127.0.0.1:1426' });
  for (const raw of ['0', '80', '65536', '1436/path', '1436.5', 'https://example.com']) {
    expect(() => resolveQaBrowserPorts({ MACRO_TAURI_BROWSER_BRIDGE_PORT: raw })).toThrow();
  }
  expect(() => resolveQaBrowserPorts({ MACRO_TAURI_BROWSER_UI_PORT: '1430' })).toThrow('distinct');
});
