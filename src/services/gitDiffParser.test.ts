import { describe, expect, it } from 'bun:test';
import { parseUnifiedDiff } from './gitDiffParser';

describe('gitDiffParser', () => {
  it('parses additions/deletions and reconstructs versions', () => {
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
  });
});
