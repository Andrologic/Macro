import { useEffect } from 'react';
import { shortcutDefinitions } from '../shortcuts/catalog';
import { bindingMatchesEvent, isEditableTarget } from '../shortcuts/utils';
import { useShortcutsStore } from '../stores/useShortcutsStore';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useProviderStore } from '../stores/useProviderStore';

const CHAT_INPUT_SELECTOR = '[data-shortcut-chat-input="true"]';

export const useGlobalShortcuts = (): void => {
  const bindings = useShortcutsStore((state) => state.bindings);
  const promptHistoryNavigationMode = useShortcutsStore((state) => state.promptHistoryNavigationMode);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const mode = useAppStore((state) => state.mode);
  const isStreaming = useChatStore((state) => state.isStreaming);

  useEffect(() => {
    const executeShortcut = (shortcutId: string): boolean => {
      const appState = useAppStore.getState();
      const chatState = useChatStore.getState();
      const providerState = useProviderStore.getState();

      switch (shortcutId) {
        case 'app.openSettings':
          appState.openSettings('shortcuts');
          return true;
        case 'app.closeSettings':
          if (!appState.settingsOpen) return false;
          appState.closeSettings();
          return true;
        case 'chat.newConversation':
          void chatState.createConversation('New Conversation', null, null);
          return true;
        case 'app.switchMode.architect':
          appState.setMode('Architect');
          return true;
        case 'app.switchMode.implement':
          appState.setMode('Implement');
          return true;
        case 'app.switchMode.chat':
          appState.setMode('Chat');
          return true;
        case 'app.toggleLeftPanel':
          appState.setLeftPanelOpen(!appState.isLeftPanelOpen);
          return true;
        case 'app.toggleRightPanel':
          appState.setRightPanelOpen(!appState.isRightPanelOpen);
          return true;
        case 'ai.cycleProvider':
          providerState.cycleProvider();
          return true;
        case 'ai.cycleModel':
          providerState.cycleModel();
          return true;
        case 'chat.stopStreaming':
          if (!chatState.isStreaming) return false;
          chatState.stopStreaming();
          return true;
        case 'chat.focusInput': {
          const element = document.querySelector<HTMLInputElement>(CHAT_INPUT_SELECTOR);
          if (!element) return false;
          element.focus();
          return true;
        }
        case 'chat.historyPrevious':
          window.dispatchEvent(new CustomEvent('macro:prompt-history', { detail: { direction: 'up' } }));
          return true;
        case 'chat.historyNext':
          window.dispatchEvent(new CustomEvent('macro:prompt-history', { detail: { direction: 'down' } }));
          return true;
        default:
          return false;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      const editable = isEditableTarget(event.target);
      const focusedElement = document.activeElement;
      const isChatInputFocused =
        focusedElement instanceof HTMLElement && focusedElement.matches(CHAT_INPUT_SELECTOR);

      const matchingShortcut = shortcutDefinitions.find((definition) => {
        const binding = bindings[definition.id];
        if (!binding) return false;

        if (editable && !definition.allowInEditable) return false;
        if (!bindingMatchesEvent(binding, event)) return false;

        if (definition.id === 'chat.stopStreaming' && !isStreaming) return false;
        if (definition.id.startsWith('app.switchMode') && settingsOpen) return false;
        if (definition.id === 'chat.newConversation' && mode !== 'Chat') return false;
        if (
          (definition.id === 'chat.historyPrevious' || definition.id === 'chat.historyNext') &&
          (promptHistoryNavigationMode !== 'shortcut_only' || !isChatInputFocused)
        ) {
          return false;
        }

        return true;
      });

      if (!matchingShortcut) return;

      const executed = executeShortcut(matchingShortcut.id);
      if (executed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bindings, isStreaming, mode, promptHistoryNavigationMode, settingsOpen]);
};
