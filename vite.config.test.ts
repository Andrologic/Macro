import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import viteConfig, { isPathInside, validatePublicSecretFiles } from './vite.config';

it('keeps startup CSS and the shared preload helper out of deferred vendor chunks', async () => {
  if (typeof viteConfig !== 'function') throw new Error('Expected Vite config factory');
  const config = await viteConfig({ command: 'build', mode: 'production' });
  const output = config.build?.rollupOptions?.output;
  if (!output || Array.isArray(output) || typeof output.manualChunks !== 'function') {
    throw new Error('Expected the production chunk selector');
  }
  const graph = { getModuleIds: () => [][Symbol.iterator](), getModuleInfo: () => null };
  expect(output.manualChunks('/fixture/node_modules/xterm/lib/xterm.js', graph)).toBe('terminal-vendor');
  expect(output.manualChunks('/fixture/node_modules/xterm/css/xterm.css', graph)).toBeUndefined();
  expect(output.manualChunks('\0vite/preload-helper.js', graph)).toBe('utils-vendor');
});

it('publishes only explicit public Vite values and excludes bridge tokens from builds', async () => {
  if (typeof viteConfig !== 'function') throw new Error('Expected Vite config factory');
  const previous = {
    auth: process.env.VITE_REMOTE_AUTH_TOKEN,
    apiSecret: process.env.VITE_REMOTE_API_SECRET,
    backendToken: process.env.VITE_REMOTE_BACKEND_TOKEN,
    bridge: process.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN,
    base: process.env.VITE_REMOTE_API_BASE_URL,
    demo: process.env.VITE_MACRO_DEMO,
    bridgePort: process.env.VITE_TAURI_BROWSER_BRIDGE_PORT,
  };
  process.env.VITE_REMOTE_AUTH_TOKEN = 'bundle-secret-sentinel';
  process.env.VITE_REMOTE_API_SECRET = 'api-secret-sentinel';
  process.env.VITE_REMOTE_BACKEND_TOKEN = 'backend-secret-sentinel';
  process.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN = 'bridge-secret-sentinel';
  process.env.VITE_REMOTE_API_BASE_URL = 'http://127.0.0.1:8787';
  process.env.VITE_MACRO_DEMO = '1';
  process.env.VITE_TAURI_BROWSER_BRIDGE_PORT = '1449';
  try {
    const config = await viteConfig({ command: 'build', mode: 'production' });
    expect(config.envPrefix).toBe('__MACRO_NO_PUBLIC_ENV__');
    const defines = config.define ?? {};
    expect(defines['import.meta.env.VITE_REMOTE_API_BASE_URL']).toBe('"http://127.0.0.1:8787"');
    expect(defines['import.meta.env.VITE_REMOTE_AUTH_TOKEN']).toBeUndefined();
    expect(defines['import.meta.env.VITE_REMOTE_API_SECRET']).toBeUndefined();
    expect(defines['import.meta.env.VITE_REMOTE_BACKEND_TOKEN']).toBeUndefined();
    expect(defines['import.meta.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN']).toBe('""');
    expect(defines['import.meta.env.VITE_MACRO_DEMO']).toBe('""');
    expect(defines['import.meta.env.VITE_TAURI_BROWSER_BRIDGE_PORT']).toBe('undefined');

    const devConfig = await viteConfig({ command: 'serve', mode: 'development' });
    expect(devConfig.define?.['import.meta.env.VITE_MACRO_DEMO']).toBe('"1"');
    expect(devConfig.define?.['import.meta.env.VITE_TAURI_BROWSER_BRIDGE_PORT']).toBe('"1449"');
    expect(devConfig.define?.['import.meta.env.VITE_TAURI_BROWSER_BRIDGE_TOKEN'])
      .toBe('"bridge-secret-sentinel"');
    delete process.env.VITE_TAURI_BROWSER_BRIDGE_PORT;
    const defaultConfig = await viteConfig({ command: 'serve', mode: 'development' });
    expect(defaultConfig.define?.['import.meta.env.VITE_TAURI_BROWSER_BRIDGE_PORT']).toBe('undefined');
  } finally {
    for (const [key, value] of Object.entries({
      VITE_REMOTE_AUTH_TOKEN: previous.auth,
      VITE_REMOTE_API_SECRET: previous.apiSecret,
      VITE_REMOTE_BACKEND_TOKEN: previous.backendToken,
      VITE_TAURI_BROWSER_BRIDGE_TOKEN: previous.bridge,
      VITE_REMOTE_API_BASE_URL: previous.base,
      VITE_MACRO_DEMO: previous.demo,
      VITE_TAURI_BROWSER_BRIDGE_PORT: previous.bridgePort,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

const tempDirs: string[] = [];

describe('isPathInside', () => {
  it('recognizes descendants using the host path separator', () => {
    const root = join(tmpdir(), 'macro-parser');

    expect(isPathInside(root, join(root, 'src', 'parse.ts'))).toBe(true);
    expect(isPathInside(root, join(tmpdir(), 'macro-parser-sibling', 'parse.ts'))).toBe(false);
  });
});

describe('validatePublicSecretFiles', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('allows builds when no prohibited secret files exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-vite-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public', 'logo.svg'), '<svg />');

    expect(() => validatePublicSecretFiles(root)).not.toThrow();
  });

  it('rejects legacy ai-keys files in public', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-vite-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public', 'ai-keys.local.json'), '{"providers":{}}');

    expect(() => validatePublicSecretFiles(root)).toThrow(/public/);
  });
});
