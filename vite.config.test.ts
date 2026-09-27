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
