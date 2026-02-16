export type ShortcutCategory = 'app' | 'mode' | 'layout' | 'chat' | 'ai';

export type ShortcutId =
  | 'app.openSettings'
  | 'app.closeSettings'
  | 'chat.newConversation'
  | 'app.switchMode.architect'
  | 'app.switchMode.implement'
  | 'app.switchMode.chat'
  | 'app.switchMode.debug'
  | 'app.toggleLeftPanel'
  | 'app.toggleRightPanel'
  | 'ai.cycleProvider'
  | 'ai.cycleModel'
  | 'chat.stopStreaming'
  | 'chat.focusInput'
  | 'chat.historyPrevious'
  | 'chat.historyNext';

export interface ShortcutDefinition {
  id: ShortcutId;
  category: ShortcutCategory;
  label: string;
  description: string;
  defaultBinding: string | null;
  allowInEditable?: boolean;
}

export const shortcutDefinitions: ShortcutDefinition[] = [
  {
    id: 'app.openSettings',
    category: 'app',
    label: 'Open settings',
    description: 'Open application settings',
    defaultBinding: 'Mod+,',
  },
  {
    id: 'app.closeSettings',
    category: 'app',
    label: 'Close settings',
    description: 'Close settings modal',
    defaultBinding: 'Escape',
    allowInEditable: true,
  },
  {
    id: 'chat.newConversation',
    category: 'chat',
    label: 'New conversation',
    description: 'Start a new chat conversation',
    defaultBinding: 'Mod+N',
  },
  {
    id: 'app.switchMode.architect',
    category: 'mode',
    label: 'Switch to Architect mode',
    description: 'Switch active mode to Architect',
    defaultBinding: 'Mod+1',
  },
  {
    id: 'app.switchMode.implement',
    category: 'mode',
    label: 'Switch to Implement mode',
    description: 'Switch active mode to Implement',
    defaultBinding: 'Mod+2',
  },
  {
    id: 'app.switchMode.chat',
    category: 'mode',
    label: 'Switch to Chat mode',
    description: 'Switch active mode to Chat',
    defaultBinding: 'Mod+3',
  },
  {
    id: 'app.switchMode.debug',
    category: 'mode',
    label: 'Switch to Debug mode',
    description: 'Switch active mode to Debug',
    defaultBinding: 'Mod+4',
  },
  {
    id: 'app.toggleLeftPanel',
    category: 'layout',
    label: 'Toggle left panel',
    description: 'Show or hide the left panel',
    defaultBinding: 'Mod+[',
  },
  {
    id: 'app.toggleRightPanel',
    category: 'layout',
    label: 'Toggle right panel',
    description: 'Show or hide the right panel',
    defaultBinding: 'Mod+]',
  },
  {
    id: 'ai.cycleProvider',
    category: 'ai',
    label: 'Next provider',
    description: 'Switch to next enabled provider',
    defaultBinding: 'Mod+Shift+P',
  },
  {
    id: 'ai.cycleModel',
    category: 'ai',
    label: 'Next model',
    description: 'Switch to next enabled model',
    defaultBinding: 'Mod+Shift+M',
  },
  {
    id: 'chat.stopStreaming',
    category: 'chat',
    label: 'Stop streaming',
    description: 'Stop the current assistant response',
    defaultBinding: 'Mod+.',
  },
  {
    id: 'chat.focusInput',
    category: 'chat',
    label: 'Focus chat input',
    description: 'Move cursor to chat composer',
    defaultBinding: 'Mod+/',
  },
  {
    id: 'chat.historyPrevious',
    category: 'chat',
    label: 'Prompt history previous',
    description: 'Navigate to the previous prompt in chat input',
    defaultBinding: 'Mod+ArrowUp',
    allowInEditable: true,
  },
  {
    id: 'chat.historyNext',
    category: 'chat',
    label: 'Prompt history next',
    description: 'Navigate to the next prompt in chat input',
    defaultBinding: 'Mod+ArrowDown',
    allowInEditable: true,
  },
];

export const shortcutDefaults = shortcutDefinitions.reduce<Record<ShortcutId, string | null>>(
  (acc, definition) => {
    acc[definition.id] = definition.defaultBinding;
    return acc;
  },
  {} as Record<ShortcutId, string | null>
);

export const shortcutDefinitionsById = shortcutDefinitions.reduce<Record<ShortcutId, ShortcutDefinition>>(
  (acc, definition) => {
    acc[definition.id] = definition;
    return acc;
  },
  {} as Record<ShortcutId, ShortcutDefinition>
);
