import { describe, expect, test } from 'bun:test';
import {
  IGNORED_PREFIXES,
  coverageDirectoryFor,
  filterFiles,
  isIgnoredPath,
  parseRunOptions,
  resolveConfiguredConcurrency,
  resolveConcurrency,
  runWithConcurrency,
  selectFilesForOptions,
  selectTestFiles,
  spawnArgsForFile,
  usesProductionConditions,
} from './run-tests.mjs';
import { formatDuration } from './format-duration.mjs';

describe('test file selection', () => {
  test('ignores worktrees, build output, and dependencies', () => {
    expect(IGNORED_PREFIXES).toContain('.worktrees/');
    expect(isIgnoredPath('.worktrees/refactor-local-test-pipeline/src/a.test.ts')).toBe(true);
    expect(isIgnoredPath('node_modules/x/y.test.ts')).toBe(true);
    expect(isIgnoredPath('src/a.test.ts')).toBe(false);
  });

  test('keeps only test files, normalized and sorted', () => {
    const selected = selectTestFiles([
      './src/b.test.tsx',
      'src\\a.test.ts',
      'src/component.tsx',
      '.worktrees/other/src/c.test.ts',
      'src/a.test.ts',
      'dist/generated.test.ts',
    ]);
    expect(selected).toEqual(['src/a.test.ts', 'src/b.test.tsx']);
  });
});

describe('per-file spawn arguments', () => {
  test('keeps React in test mode but selects Lexical production exports for ComposerEditor', () => {
    expect(usesProductionConditions('src\\components\\chat\\composer\\ComposerEditor.test.tsx')).toBe(true);
    expect(spawnArgsForFile('src/components/chat/composer/ComposerEditor.test.tsx')).toEqual([
      '--conditions=production',
      'test',
      '--timeout=30000',
      'src/components/chat/composer/ComposerEditor.test.tsx',
    ]);
  });

  test('runs every other file with plain test conditions', () => {
    expect(spawnArgsForFile('src/stores/workspace.test.ts')).toEqual([
      'test',
      '--timeout=30000',
      'src/stores/workspace.test.ts',
    ]);
  });

  test('coverage opt-in writes an isolated lcov report directory per file', () => {
    const args = spawnArgsForFile('src/services/git/review.test.ts', { coverage: true });
    expect(args).toEqual([
      'test',
      '--timeout=30000',
      '--coverage',
      '--coverage-reporter=lcov',
      '--coverage-dir=coverage/tests/src_services_git_review-5d3694dd',
      'src/services/git/review.test.ts',
    ]);
    expect(coverageDirectoryFor('coverage/tests/', 'src/a/b.test.tsx')).toMatch(
      /^coverage\/tests\/src_a_b-[a-f0-9]{8}$/,
    );
    expect(coverageDirectoryFor('coverage/tests', 'src/a-b.test.ts')).not.toBe(
      coverageDirectoryFor('coverage/tests', 'src/a_b.test.ts'),
    );
  });
});

describe('run options', () => {
  test('parses flags and positional filters', () => {
    const options = parseRunOptions(['--concurrency=3', '--coverage', '--', 'stores']);
    expect(options.concurrency).toBe(3);
    expect(options.coverage).toBe(true);
    expect(options.filters).toEqual(['stores']);
    expect(options.only).toEqual([]);
  });

  test('parses and deduplicates exact test paths', () => {
    const options = parseRunOptions(['--only', 'src\\a.test.ts', '--only=src/b.test.tsx']);
    expect(options.only).toEqual(['src/a.test.ts', 'src/b.test.tsx']);
    expect(selectFilesForOptions(
      ['src/a.test.ts', 'src/b.test.tsx', 'src/ab.test.ts'],
      options,
    )).toEqual(['src/a.test.ts', 'src/b.test.tsx']);
  });

  test('rejects missing exact paths and ambiguous filter combinations', () => {
    expect(() => selectFilesForOptions(
      ['src/a.test.ts'],
      parseRunOptions(['--only', 'src/missing.test.ts']),
    )).toThrow(/not found/i);
    expect(() => parseRunOptions(['--only', 'src/a.test.ts', 'stores'])).toThrow(/cannot be combined/i);
    expect(() => parseRunOptions(['--only'])).toThrow(/requires an exact/i);
  });

  test('rejects unknown options and invalid concurrency', () => {
    expect(() => parseRunOptions(['--watch'])).toThrow(/Unknown option/);
    expect(() => resolveConcurrency(Number('0'))).toThrow(/concurrency/i);
    expect(() => resolveConcurrency(1.5)).toThrow(/integer/i);
  });

  test('prefers the CLI concurrency and otherwise reads the environment', () => {
    expect(resolveConfiguredConcurrency(3, '5')).toBe(3);
    expect(resolveConfiguredConcurrency(undefined, '5')).toBe(5);
    expect(() => resolveConfiguredConcurrency(undefined, 'invalid')).toThrow(/concurrency/i);
  });

  test('filters are case-insensitive substrings', () => {
    expect(filterFiles(['src/stores/A.test.ts'], ['stores/a'])).toEqual(['src/stores/A.test.ts']);
    expect(filterFiles(['src/a.test.ts'], [])).toEqual(['src/a.test.ts']);
  });
});

describe('bounded concurrency runner', () => {
  test('never exceeds the limit and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const results = await runWithConcurrency([30, 10, 20, 40], 2, async (delay) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return delay * 2;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual([60, 20, 40, 80]);
  });

  test('handles fewer items than slots', async () => {
    const results = await runWithConcurrency(['a'], 8, async (item) => item.toUpperCase());
    expect(results).toEqual(['A']);
  });

  test('rejects an invalid worker limit instead of silently skipping work', async () => {
    expect(runWithConcurrency(['a'], 0, async (item) => item)).rejects.toThrow(/worker limit/i);
  });

  test('stops scheduling new work after a worker throws', async () => {
    const started = [];
    await expect(runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      if (item === 1) {
        throw new Error('spawn failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return item;
    })).rejects.toThrow('spawn failed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([1, 2]);
  });
});

describe('duration formatting', () => {
  test('renders seconds under a minute and minutes beyond', () => {
    expect(formatDuration(5000)).toBe('5.0s');
    expect(formatDuration(59000)).toBe('59.0s');
    expect(formatDuration(61000)).toBe('1m 1s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });
});
