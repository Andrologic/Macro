import i18n from '../i18n';
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
    void i18n.changeLanguage('en');
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

  it.each([
    ['1', '&', 'Digit1'], ['2', 'é', 'Digit2'], ['3', '"', 'Digit3'],
    ['/', ':', 'Slash'], ['.', ';', 'Period'], [',', 'm', 'Comma'],
    ['[', '^', 'BracketLeft'], [']', '$', 'BracketRight'],
  ])('matches Mod+%s by physical code on other layouts', (key, layoutKey, code) => {
    for (const platform of ['MacIntel', 'Win32']) {
      setPlatform(platform);
      const modifiers = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true };
      const event = new KeyboardEvent('keydown', { key: layoutKey, code, ...modifiers });
      expect(bindingMatchesEvent(`Mod+${key}`, event)).toBe(true);
      expect(bindingMatchesEvent(`Mod+${layoutKey}`, event)).toBe(true);
      expect(bindingMatchesEvent(`Mod+Shift+${key}`, event)).toBe(false);
      expect(bindingMatchesEvent(`Alt+${key}`, event)).toBe(false);
    }
  });

  it('separates typed-key and physical-key matches for callers that rank them', () => {
    setPlatform('MacIntel');
    const event = new KeyboardEvent('keydown', { key: ';', code: 'Comma', metaKey: true });
    expect(bindingMatchesEvent('Mod+;', event, 'key')).toBe(true);
    expect(bindingMatchesEvent('Mod+;', event, 'physical')).toBe(false);
    expect(bindingMatchesEvent('Mod+,', event, 'key')).toBe(false);
    expect(bindingMatchesEvent('Mod+,', event, 'physical')).toBe(true);
  });

  it('keeps letter shortcuts tied to the typed key', () => {
    setPlatform('Win32');
    const event = new KeyboardEvent('keydown', { key: 'a', code: 'KeyQ', ctrlKey: true });
    expect(bindingMatchesEvent('Mod+A', event)).toBe(true);
    expect(bindingMatchesEvent('Mod+Q', event)).toBe(false);
  });

  it('localizes disabled shortcut labels with the existing common translation', async () => {
    i18n.addResourceBundle('fr', 'translation', { common: { disabled: 'Désactivé' } }, true, true);
    await i18n.changeLanguage('fr');
    expect(formatBindingForDisplay(null)).toBe('Désactivé');
  });

});
