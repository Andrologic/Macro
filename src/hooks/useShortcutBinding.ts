import { useSyncExternalStore } from 'react';
import type { ShortcutId } from '../shortcuts/catalog';
import { commandRegistry } from '../shortcuts/runtime';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useShortcutsStore } from '../stores/useShortcutsStore';

/** Display only: command constraints such as composer focus are checked at dispatch. */
export function useShortcutBinding(id: ShortcutId): string | null {
  useSyncExternalStore(commandRegistry.subscribe, commandRegistry.getRevision, commandRegistry.getRevision);
  const mode = useAppStore((state) => state.mode);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const promptHistoryNavigationMode = useShortcutsStore((state) => state.promptHistoryNavigationMode);
  const binding = useShortcutsStore((state) => state.bindings?.[id]);
  const isStreaming = useChatStore((state) => Boolean(state.selectedConversationId &&
    state.getConversationRuntime(state.selectedConversationId).phase === 'streaming'));
  const command = commandRegistry.get(id, {
    mode, settingsOpen, promptHistoryNavigationMode, isStreaming,
    editable: false, isChatInputFocused: false,
  });
  if (!command) return null;
  return binding === undefined ? command.definition.defaultBinding : binding;
}
