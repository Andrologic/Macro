import { afterEach, describe, expect, it } from 'bun:test';
import {
  bindingMatchesEvent,
  eventToBinding,
  formatBindingForDisplay,
  normalizeBinding,
} from './utils';

const originalPlatform = navigator.platform;

const setPlatform = (platform: string) => {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: platform,
  });
};

describe('shortcut utils', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('normalizes modifier aliases and special keys', () => {
    expect(normalizeBinding('mod + shift + p')).toBe('Mod+Shift+P');
    expect(normalizeBinding('ctrl + comma')).toBe('Ctrl+,');
    expect(normalizeBinding('option + slash')).toBe('Alt+/');
    expect(normalizeBinding('cmd + return')).toBe('Meta+Enter');
  });

  it('maps platform command keys to Mod bindings', () => {
    setPlatform('MacIntel');
    expect(eventToBinding(new KeyboardEvent('keydown', { key: ',', metaKey: true }))).toBe('Mod+,');

    setPlatform('Win32');
    expect(eventToBinding(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true }))).toBe('Mod+M');
    expect(eventToBinding(new KeyboardEvent('keydown', { key: 'm', metaKey: true }))).toBe('Meta+M');
  });

  it('formats Mod bindings for the current platform', () => {
    setPlatform('MacIntel');
    expect(formatBindingForDisplay('Mod+/')).toBe('Cmd + /');

    setPlatform('Win32');
    expect(formatBindingForDisplay('Mod+/')).toBe('Ctrl + /');
  });

  it('matches keyboard events against normalized bindings', () => {
    setPlatform('MacIntel');

    expect(
      bindingMatchesEvent('Mod+Shift+P', new KeyboardEvent('keydown', {
        key: 'p',
        metaKey: true,
        shiftKey: true,
      }))
    ).toBe(true);
    expect(
      bindingMatchesEvent('Mod+Shift+P', new KeyboardEvent('keydown', {
        key: 'p',
        metaKey: true,
      }))
    ).toBe(false);
  });
});
