import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from 'vite';
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

it('excludes the obsolete remote bearer from Vite environment exposure', async () => {
  if (typeof viteConfig !== 'function') throw new Error('Expected Vite config factory');
  const config = await viteConfig({ command: 'build', mode: 'production' });
  const prefixes = config.envPrefix;
  if (!Array.isArray(prefixes)) throw new Error('Expected explicit public environment prefixes');
  const previous = process.env.VITE_REMOTE_AUTH_TOKEN;
  process.env.VITE_REMOTE_AUTH_TOKEN = 'bundle-secret-sentinel';
  try {
    const exposed = loadEnv('production', process.cwd(), prefixes);
    expect(exposed.VITE_REMOTE_AUTH_TOKEN).toBeUndefined();
    expect(prefixes.some((prefix) => 'VITE_REMOTE_API_BASE_URL'.startsWith(prefix))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.VITE_REMOTE_AUTH_TOKEN;
    else process.env.VITE_REMOTE_AUTH_TOKEN = previous;
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
