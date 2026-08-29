import { describe, expect, test } from 'bun:test';
import { buildDiffArgs, classifyPaths, parseNameStatus } from './classify-changes.mjs';

describe('classifyPaths', () => {
  test('keeps documentation-only changes cheap', () => {
    expect(classifyPaths(['docs/ci.md', 'README.md'])).toEqual({
      documentation_only: true,
      frontend: false,
      native: false,
      sidecar: false,
      configuration: false,
      linux: false,
      windows: false,
    });
  });

  test('does not treat Markdown shipped with application code as documentation-only', () => {
    for (const path of [
      'src/help.md',
      'public/content.md',
      'src-tauri/resources/licenses/runtime-LICENSE.md',
    ]) {
      const result = classifyPaths([path]);
      expect(result.documentation_only).toBe(false);
      expect(result.linux).toBe(true);
    }
  });

  test('runs Linux validation for frontend changes', () => {
    const result = classifyPaths(['src/components/App.tsx']);
    expect(result.linux).toBe(true);
    expect(result.windows).toBe(false);
  });

  test('runs Linux and Windows validation for Rust changes', () => {
    const result = classifyPaths(['src-tauri/src/main.rs']);
    expect(result.native).toBe(true);
    expect(result.sidecar).toBe(false);
    expect(result.linux).toBe(true);
    expect(result.windows).toBe(true);
  });

  test('identifies sidecar changes without broadening unrelated native changes', () => {
    for (const path of [
      'copilot-bridge/src/index.ts',
      'dev/build-ai-runtime.mjs',
      'dev/ai-runtime-linux-wrapper.mjs',
    ]) {
      const result = classifyPaths([path]);
      expect(result.native).toBe(true);
      expect(result.sidecar).toBe(true);
      expect(result.linux).toBe(true);
      expect(result.windows).toBe(true);
    }
  });

  test('treats workflows and manifests conservatively', () => {
    for (const path of ['.github/workflows/ci.yml', 'package.json', 'bun.lock']) {
      const result = classifyPaths([path]);
      expect(result.configuration).toBe(true);
      expect(result.linux).toBe(true);
      expect(result.windows).toBe(true);
    }
  });

  test('treats unknown paths conservatively', () => {
    const result = classifyPaths(['unclassified.config']);
    expect(result.configuration).toBe(true);
    expect(result.linux).toBe(true);
    expect(result.windows).toBe(true);
  });
});

describe('parseNameStatus', () => {
  test('retains deleted paths', () => {
    expect(parseNameStatus('D\0src-tauri/src/old.rs\0')).toEqual(['src-tauri/src/old.rs']);
  });

  test('retains both sides of a rename', () => {
    const paths = parseNameStatus('R100\0docs/old.md\0src/new.ts\0');
    expect(paths).toEqual(['docs/old.md', 'src/new.ts']);
    expect(classifyPaths(paths).linux).toBe(true);
  });
});

describe('buildDiffArgs', () => {
  test('uses merge-base semantics for pull requests', () => {
    expect(buildDiffArgs('base', 'head', 'merge-base')).toEqual([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      'base...head',
    ]);
  });

  test('uses the exact pushed range for branch pushes', () => {
    expect(buildDiffArgs('before', 'after', 'direct')).toEqual([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      'before',
      'after',
    ]);
  });

  test('classifies a newly created ref conservatively', () => {
    expect(buildDiffArgs('0000000000000000000000000000000000000000', 'head', 'direct')).toBeNull();
  });
});
