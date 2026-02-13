import { describe, expect, it } from 'bun:test';
import { assertPathAllowed, globToRegex, isWriteTool, pathMatchesGlob } from './workspaceToolExecutor';

describe('workspaceToolExecutor helpers', () => {
  it('flags write tools correctly', () => {
    expect(isWriteTool('write')).toBe(true);
    expect(isWriteTool('edit')).toBe(true);
    expect(isWriteTool('read')).toBe(false);
  });

  it('enforces architect write path scope', () => {
    expect(() => assertPathAllowed('Architect', '.macro/branches/main/plan.md')).not.toThrow();
    expect(() => assertPathAllowed('Architect', 'src/App.tsx')).toThrow();
    expect(() => assertPathAllowed('Chat', 'src/App.tsx')).not.toThrow();
  });

  it('matches glob patterns', () => {
    const regex = globToRegex('src/**/*.ts');
    expect(regex.test('src/services/toolModePolicy.ts')).toBe(true);
    expect(pathMatchesGlob('src/services/toolModePolicy.ts', 'src/**/*.ts')).toBe(true);
    expect(pathMatchesGlob('src/components/App.tsx', 'src/**/*.ts')).toBe(false);
  });
});
