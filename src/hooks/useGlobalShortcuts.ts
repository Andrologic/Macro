import { useEffect } from 'react';
import { CHAT_INPUT_SELECTOR, commandRegistry, executeShortcut, isShortcutAvailable } from '../shortcuts/runtime';
import { bindingMatchesEvent, isEditableTarget } from '../shortcuts/utils';
import { useShortcutsStore } from '../stores/useShortcutsStore';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useConversationGoalStore } from '../stores/useConversationGoalStore';
import { hasOpenDialog } from '../components/ui/dialogPresence';
import { isTopmostDialog } from '../components/ui/Dialog';

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
      if (event.repeat || event.defaultPrevented) return;
      const dialogOpen = hasOpenDialog();
      if (dialogOpen && !isTopmostDialog('settings')) return;

      const editable = isEditableTarget(event.target);
      const focusedElement = document.activeElement;
      const isChatInputFocused =
        focusedElement instanceof HTMLElement && focusedElement.matches(CHAT_INPUT_SELECTOR);

      const availability = {
        editable,
        isChatInputFocused,
        isStreaming,
        mode,
        promptHistoryNavigationMode,
        settingsOpen,
      };
      const commands = commandRegistry.list(availability);
      const findShortcut = (mode: 'key' | 'physical') => commands.find((command) => {
        if (dialogOpen && command.id !== 'app.closeSettings') return false;
        const definition = { ...command.definition, id: command.id };
        const binding = Object.hasOwn(bindings, definition.id)
          ? bindings[definition.id]
          : definition.defaultBinding;
        return Boolean(binding && bindingMatchesEvent(binding, event, mode)) &&
          isShortcutAvailable(definition, availability);
      });
      // The produced character wins over the physical-key fallback.
      const matchingShortcut = findShortcut('key') ?? findShortcut('physical');

      if (!matchingShortcut) return;

      const executed = executeShortcut(matchingShortcut.id, {
        appState: useAppStore.getState(),
        chatState: useChatStore.getState(),
        providerState: useProviderStore.getState(),
        availability,
        onStreamStopped: (conversationId) => {
          const goalState = useConversationGoalStore.getState();
          if (goalState.goalsByConversationId[conversationId]?.status === 'executor_running') {
            goalState.setOperationalStatus(conversationId, 'paused');
          }
        },
        document,
        window,
      });
      if (executed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bindings, isStreaming, mode, promptHistoryNavigationMode, settingsOpen]);
};
