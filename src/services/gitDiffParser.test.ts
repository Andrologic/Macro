import { describe, expect, it } from 'bun:test';
import { buildSplitDiffRows, parseUnifiedDiff, parseUnifiedDiffFiles } from './gitDiffParser';

describe('gitDiffParser', () => {
  it('parses additions/deletions, hunks, and reconstructs versions', () => {
    const patch = [
      'diff --git a/src/file.ts b/src/file.ts',
      'index 111..222 100644',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' console.log(a, b);',
    ].join('\n');

    const parsed = parseUnifiedDiff(patch);
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
    expect(parsed.originalContent.includes('const b = 2;')).toBe(true);
    expect(parsed.modifiedContent.includes('const b = 3;')).toBe(true);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]?.lines).toEqual([
      { type: 'context', content: 'const a = 1;', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'removed', content: 'const b = 2;', oldLineNumber: 2, newLineNumber: null },
      { type: 'added', content: 'const b = 3;', oldLineNumber: null, newLineNumber: 2 },
      { type: 'context', content: 'console.log(a, b);', oldLineNumber: 3, newLineNumber: 3 },
    ]);
  });

  it('handles pure additions', () => {
    const patch = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1;',
      '+export const y = 2;',
    ].join('\n');

    const parsed = parseUnifiedDiff(patch);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(0);
    expect(parsed.originalContent.trim()).toBe('');
    expect(parsed.modifiedContent.includes('export const x = 1;')).toBe(true);
    expect(parsed.hunks[0]?.oldStart).toBe(0);
    expect(parsed.hunks[0]?.newStart).toBe(1);
    expect(parsed.hunks[0]?.lines[0]).toEqual({
      type: 'added',
      content: 'export const x = 1;',
      oldLineNumber: null,
      newLineNumber: 1,
    });
  });

  it('preserves multiple hunks with line numbers', () => {
    const patch = [
      'diff --git a/src/file.ts b/src/file.ts',
      'index 111..222 100644',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-line 2',
      '+line 2 updated',
      ' line 3',
      '@@ -10,2 +10,3 @@',
      ' line 10',
      '+line 10.5',
      ' line 11',
    ].join('\n');

    const parsed = parseUnifiedDiff(patch);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[1]).toMatchObject({
      oldStart: 10,
      oldCount: 2,
      newStart: 10,
      newCount: 3,
    });
    expect(parsed.hunks[1]?.lines[1]).toEqual({
      type: 'added',
      content: 'line 10.5',
      oldLineNumber: null,
      newLineNumber: 11,
    });
  });

  it('builds aligned split rows for replacements with different line counts', () => {
    const rows = buildSplitDiffRows(
      'alpha\nbeta\ngamma',
      'alpha\nbeta updated\nbeta extra\ngamma'
    );

    expect(rows).toEqual([
      {
        kind: 'context',
        leftLineNumber: 1,
        rightLineNumber: 1,
        leftContent: 'alpha',
        rightContent: 'alpha',
      },
      {
        kind: 'modified',
        leftLineNumber: 2,
        rightLineNumber: 2,
        leftContent: 'beta',
        rightContent: 'beta updated',
      },
      {
        kind: 'added',
        leftLineNumber: null,
        rightLineNumber: 3,
        leftContent: '',
        rightContent: 'beta extra',
      },
      {
        kind: 'context',
        leftLineNumber: 3,
        rightLineNumber: 4,
        leftContent: 'gamma',
        rightContent: 'gamma',
      },
    ]);
  });

  it('builds aligned split rows for pure deletions and pure additions', () => {
    const rows = buildSplitDiffRows(
      'line one\nline two',
      'line two\nline three'
    );

    expect(rows).toEqual([
      {
        kind: 'removed',
        leftLineNumber: 1,
        rightLineNumber: null,
        leftContent: 'line one',
        rightContent: '',
      },
      {
        kind: 'context',
        leftLineNumber: 2,
        rightLineNumber: 1,
        leftContent: 'line two',
        rightContent: 'line two',
      },
      {
        kind: 'added',
        leftLineNumber: null,
        rightLineNumber: 2,
        leftContent: '',
        rightContent: 'line three',
      },
    ]);
  });

  it('splits an aggregated git diff into modified files', () => {
    const files = parseUnifiedDiffFiles([
      'diff --git a/src/one.ts b/src/one.ts',
      'index 111..222 100644',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      'diff --git a/src/two.ts b/src/two.ts',
      'index 333..444 100644',
      '--- a/src/two.ts',
      '+++ b/src/two.ts',
      '@@ -1 +1,2 @@',
      ' two',
      '+extra',
    ].join('\n'));

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      oldPath: 'src/one.ts',
      path: 'src/one.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
    });
    expect(files[1]).toMatchObject({
      oldPath: 'src/two.ts',
      path: 'src/two.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
    });
  });

  it('detects added files in aggregated git diffs', () => {
    const files = parseUnifiedDiffFiles([
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+new file',
    ].join('\n'));

    expect(files[0]).toMatchObject({
      oldPath: null,
      path: 'src/new.ts',
      status: 'added',
      additions: 1,
      deletions: 0,
    });
  });

  it('detects deleted files in aggregated git diffs', () => {
    const files = parseUnifiedDiffFiles([
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-old file',
    ].join('\n'));

    expect(files[0]).toMatchObject({
      oldPath: 'src/old.ts',
      path: 'src/old.ts',
      status: 'deleted',
      additions: 0,
      deletions: 1,
    });
  });

  it('detects renamed files in aggregated git diffs', () => {
    const files = parseUnifiedDiffFiles([
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 87%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -1 +1 @@',
      '-old name',
      '+new name',
    ].join('\n'));

    expect(files[0]).toMatchObject({
      oldPath: 'src/old-name.ts',
      path: 'src/new-name.ts',
      status: 'renamed',
      additions: 1,
      deletions: 1,
    });
  });

  it('handles quoted paths with spaces in aggregated git diffs', () => {
    const files = parseUnifiedDiffFiles([
      'diff --git "a/src/old file.ts" "b/src/new file.ts"',
      'similarity index 91%',
      'rename from src/old file.ts',
      'rename to src/new file.ts',
      '--- "a/src/old file.ts"',
      '+++ "b/src/new file.ts"',
      '@@ -1 +1 @@',
      '-old file',
      '+new file',
    ].join('\n'));

    expect(files[0]).toMatchObject({
      oldPath: 'src/old file.ts',
      path: 'src/new file.ts',
      status: 'renamed',
    });
  });
});
