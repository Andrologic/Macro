import { describe, expect, it } from 'bun:test';
import { shortcutDefinitions } from './catalog';
import {
  getShortcutAvailability,
  shortcutRuntimeDefinitions,
  shortcutsCanConflict,
  type ShortcutAvailabilityContext,
} from './runtime';

const baseContext: ShortcutAvailabilityContext = {
  editable: false,
  isChatInputFocused: false,
  isStreaming: false,
  mode: 'Chat',
  promptHistoryNavigationMode: 'contextual_arrows',
  settingsOpen: false,
};

describe('shortcut runtime', () => {
  it('links every catalog shortcut to a matching runtime definition', () => {
    const catalogIds = shortcutDefinitions.map((definition) => definition.id).sort();
    const runtimeIds = Object.keys(shortcutRuntimeDefinitions).sort();

    expect(runtimeIds).toEqual(catalogIds);
    for (const definition of shortcutDefinitions) {
      expect(shortcutRuntimeDefinitions[definition.id].definition.id).toBe(definition.id);
    }
  });

  it('returns typed availability reasons for context-gated shortcuts', () => {
    expect(getShortcutAvailability('app.openSettings', baseContext)).toEqual({
      available: true,
      reason: 'available',
    });
    expect(getShortcutAvailability('app.closeSettings', baseContext).reason).toBe('settingsClosed');
    expect(
      getShortcutAvailability('chat.newConversation', {
        ...baseContext,
        mode: 'Architect',
      }).reason
    ).toBe('wrongMode');
    expect(
      getShortcutAvailability('app.switchMode.architect', {
        ...baseContext,
        settingsOpen: true,
      }).reason
    ).toBe('settingsOpen');
    expect(getShortcutAvailability('chat.stopStreaming', baseContext).reason).toBe('notStreaming');
    expect(getShortcutAvailability('chat.historyPrevious', baseContext).reason).toBe(
      'promptHistoryContextualMode'
    );
    expect(
      getShortcutAvailability('chat.historyPrevious', {
        ...baseContext,
        promptHistoryNavigationMode: 'shortcut_only',
      }).reason
    ).toBe('composerNotFocused');
  });

  it('applies editable-target rules before shortcut-specific rules', () => {
    expect(
      getShortcutAvailability('chat.newConversation', {
        ...baseContext,
        editable: true,
      }).reason
    ).toBe('disabledInEditable');

    expect(
      getShortcutAvailability('app.closeSettings', {
        ...baseContext,
        editable: true,
        settingsOpen: true,
      })
    ).toEqual({
      available: true,
      reason: 'available',
    });
  });

  it('detects conflicts only when shortcut contexts can overlap', () => {
    expect(shortcutsCanConflict('app.closeSettings', 'app.switchMode.architect')).toBe(false);
    expect(shortcutsCanConflict('chat.historyPrevious', 'chat.newConversation')).toBe(false);
    expect(shortcutsCanConflict('chat.newConversation', 'app.switchMode.chat')).toBe(true);
  });
});
