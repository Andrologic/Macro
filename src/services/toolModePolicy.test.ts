import { describe, expect, it } from 'bun:test';
import { getToolModePolicy, isMacroScopedPath } from './toolModePolicy';

describe('toolModePolicy', () => {
  it('disallows mutating and workspace tools in chat mode', () => {
    const policy = getToolModePolicy('Chat');
    expect(policy.allowedToolIds.includes('write')).toBe(false);
    expect(policy.allowedToolIds.includes('edit')).toBe(false);
    expect(policy.allowedToolIds.includes('list')).toBe(false);
    expect(policy.allowedToolIds.includes('read')).toBe(false);
    expect(policy.allowedToolIds.includes('glob')).toBe(false);
    expect(policy.allowedToolIds.includes('grep')).toBe(false);
    expect(policy.allowedToolIds.includes('mark_source_passage')).toBe(false);
    expect(policy.allowedToolIds.includes('edit_source_passage')).toBe(false);
    expect(policy.allowedToolIds.includes('web_search')).toBe(true);
    expect(policy.allowedToolIds.includes('web_fetch')).toBe(true);
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

  it('allows all tools in debug mode without macro-only write restriction', () => {
    const policy = getToolModePolicy('Debug');
    expect(policy.allowedToolIds.includes('write')).toBe(true);
    expect(policy.allowedToolIds.includes('edit')).toBe(true);
    expect(policy.allowedToolIds.includes('list')).toBe(true);
    expect(policy.allowedToolIds.includes('read')).toBe(true);
    expect(policy.allowedToolIds.includes('glob')).toBe(true);
    expect(policy.allowedToolIds.includes('grep')).toBe(true);
    expect(policy.enforceMacroOnlyWrites).toBe(false);
  });

  it('detects .macro scoped paths', () => {
    expect(isMacroScopedPath('.macro')).toBe(true);
    expect(isMacroScopedPath('.macro/branches/main/plan.md')).toBe(true);
    expect(isMacroScopedPath('./.macro/branches/main/plan.md')).toBe(true);
    expect(isMacroScopedPath('src/App.tsx')).toBe(false);
  });
});
