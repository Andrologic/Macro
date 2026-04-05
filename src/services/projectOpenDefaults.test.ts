import { describe, expect, it } from 'bun:test';
import { getDefaultProjectOpenCommand } from './projectOpenDefaults';

describe('getDefaultProjectOpenCommand', () => {
  it('returns macOS defaults', () => {
    expect(getDefaultProjectOpenCommand('editor', 'macos')).toBe('open -a "Visual Studio Code"');
    expect(getDefaultProjectOpenCommand('terminal', 'macos')).toBe('open -a Terminal');
    expect(getDefaultProjectOpenCommand('files', 'macos')).toBe('open -a Finder');
  });

  it('returns Windows defaults', () => {
    expect(getDefaultProjectOpenCommand('editor', 'windows')).toBe('code');
    expect(getDefaultProjectOpenCommand('terminal', 'windows')).toBe('wt -d');
    expect(getDefaultProjectOpenCommand('files', 'windows')).toBe('explorer');
  });

  it('returns Linux defaults', () => {
    expect(getDefaultProjectOpenCommand('editor', 'linux')).toBe('code');
    expect(getDefaultProjectOpenCommand('terminal', 'linux')).toBe('x-terminal-emulator --working-directory');
    expect(getDefaultProjectOpenCommand('files', 'linux')).toBe('xdg-open');
  });
});
