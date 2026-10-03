import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveQaBrowserLogDirectory,
  resolveQaBrowserOrigin,
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

test('allows a different loopback UI port without accepting remote origins', () => {
  expect(resolveQaBrowserOrigin({})).toBe('http://127.0.0.1:1422');
  expect(resolveQaBrowserOrigin({ build: { devUrl: 'http://127.0.0.1:1428/' } })).toBe('http://127.0.0.1:1428');
  for (const devUrl of ['http://example.com:1428', 'http://0.0.0.0:1428', 'https://127.0.0.1', 'http://user@127.0.0.1', 'http://127.0.0.1/path']) {
    expect(() => resolveQaBrowserOrigin({ build: { devUrl } })).toThrow('loopback');
  }
});
