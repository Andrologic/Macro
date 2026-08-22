import { useEffect } from 'react';
import { shortcutDefinitions } from '../shortcuts/catalog';
import { CHAT_INPUT_SELECTOR, executeShortcut, isShortcutAvailable } from '../shortcuts/runtime';
import { bindingMatchesEvent, isEditableTarget } from '../shortcuts/utils';
import { useShortcutsStore } from '../stores/useShortcutsStore';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useConversationGoalStore } from '../stores/useConversationGoalStore';
import { hasOpenDialog } from '../components/ui/Dialog';

export const useGlobalShortcuts = (): void => {
  const bindings = useShortcutsStore((state) => state.bindings);
  const promptHistoryNavigationMode = useShortcutsStore((state) => state.promptHistoryNavigationMode);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const mode = useAppStore((state) => state.mode);
  const isStreaming = useChatStore((state) => {
    const selectedConversationId = state.selectedConversationId;
    if (!selectedConversationId) {
      return false;
    }

    return state.getConversationRuntime(selectedConversationId).phase === 'streaming';
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (hasOpenDialog()) return;

      const editable = isEditableTarget(event.target);
      const focusedElement = document.activeElement;
      const isChatInputFocused =
        focusedElement instanceof HTMLElement && focusedElement.matches(CHAT_INPUT_SELECTOR);

      const matchingShortcut = shortcutDefinitions.find((definition) => {
        const binding = bindings[definition.id];
        if (!binding) return false;

        if (!bindingMatchesEvent(binding, event)) return false;

        return isShortcutAvailable(definition, {
          editable,
          isChatInputFocused,
          isStreaming,
          mode,
          promptHistoryNavigationMode,
          settingsOpen,
        });
      });

      if (!matchingShortcut) return;

      const executed = executeShortcut(matchingShortcut.id, {
        appState: useAppStore.getState(),
        chatState: useChatStore.getState(),
        providerState: useProviderStore.getState(),
        document,
        window,
      });
      if (executed) {
        if (matchingShortcut.id === 'chat.stopStreaming') {
          const conversationId = useChatStore.getState().selectedConversationId;
          const goalState = useConversationGoalStore.getState();
          if (
            conversationId &&
            goalState.goalsByConversationId[conversationId]?.status === 'executor_running'
          ) {
            goalState.setOperationalStatus(conversationId, 'paused');
          }
        }
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bindings, isStreaming, mode, promptHistoryNavigationMode, settingsOpen]);
};
