import { describe, expect, it } from 'bun:test';
import { buildSplitDiffRows, parseUnifiedDiff } from './gitDiffParser';

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
});
