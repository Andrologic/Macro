import { describe, expect, it } from 'bun:test';
import { getToolModePolicy, isMacroScopedPath } from './toolModePolicy';

describe('toolModePolicy', () => {
  it('allows write/edit in chat mode', () => {
    const policy = getToolModePolicy('Chat');
    expect(policy.allowedToolIds.includes('write')).toBe(true);
    expect(policy.allowedToolIds.includes('edit')).toBe(true);
    expect(policy.enforceMacroOnlyWrites).toBe(false);
  });

  it('enforces macro-only writes in architect mode', () => {
    const policy = getToolModePolicy('Architect');
    expect(policy.allowedToolIds.includes('write')).toBe(true);
    expect(policy.allowedToolIds.includes('edit')).toBe(true);
    expect(policy.enforceMacroOnlyWrites).toBe(true);
  });

  it('allows write/edit in implement mode', () => {
    const policy = getToolModePolicy('Implement');
    expect(policy.allowedToolIds.includes('write')).toBe(true);
    expect(policy.allowedToolIds.includes('edit')).toBe(true);
    expect(policy.enforceMacroOnlyWrites).toBe(false);
  });

  it('detects .macro scoped paths', () => {
    expect(isMacroScopedPath('.macro')).toBe(true);
    expect(isMacroScopedPath('.macro/branches/main/plan.md')).toBe(true);
    expect(isMacroScopedPath('./.macro/branches/main/plan.md')).toBe(true);
    expect(isMacroScopedPath('src/App.tsx')).toBe(false);
  });
});
