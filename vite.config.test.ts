import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePublicSecretFiles } from './vite.config';

const tempDirs: string[] = [];

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
