export type ShortcutCategory = 'app' | 'mode' | 'layout' | 'chat' | 'ai';

export type BuiltinShortcutId =
  | 'app.openSettings'
  | 'app.closeSettings'
  | 'chat.newConversation'
  | 'app.switchMode.architect'
  | 'app.switchMode.implement'
  | 'app.switchMode.chat'
  | 'app.toggleLeftPanel'
  | 'app.toggleRightPanel'
  | 'ai.cycleProvider'
  | 'ai.cycleModel'
  | 'chat.stopStreaming'
  | 'chat.focusInput'
  | 'chat.secondarySend'
  | 'chat.historyPrevious'
  | 'chat.historyNext';

// Internal UI identity only; never converted into an agent execution mode.
export type ShortcutId = BuiltinShortcutId | (string & {});

export interface ShortcutDefinition {
  id: ShortcutId;
  category: ShortcutCategory;
  label: string;
  labelKey?: string;
  description: string;
  descriptionKey?: string;
  defaultBinding: string | null;
  allowInEditable?: boolean;
}

export const shortcutDefinitions: ShortcutDefinition[] = [
  {
    id: 'app.openSettings',
    labelKey: 'shortcuts.items.appOpenSettings.label',
    descriptionKey: 'shortcuts.items.appOpenSettings.description',
    category: 'app',
    label: 'Open settings',
    description: 'Open application settings',
    defaultBinding: 'Mod+,',
  },
  {
    id: 'app.closeSettings',
    labelKey: 'shortcuts.items.appCloseSettings.label',
    descriptionKey: 'shortcuts.items.appCloseSettings.description',
    category: 'app',
    label: 'Close settings',
    description: 'Close settings modal',
    defaultBinding: 'Escape',
    allowInEditable: true,
  },
  {
    id: 'chat.newConversation',
    labelKey: 'shortcuts.items.chatNewConversation.label',
    descriptionKey: 'shortcuts.items.chatNewConversation.description',
    category: 'chat',
    label: 'New conversation',
    description: 'Start a new chat conversation',
    defaultBinding: 'Mod+N',
  },
  {
    id: 'app.switchMode.architect',
    labelKey: 'shortcuts.items.switchArchitect.label',
    descriptionKey: 'shortcuts.items.switchArchitect.description',
    category: 'mode',
    label: 'Switch to Architect mode',
    description: 'Switch active mode to Architect',
    defaultBinding: 'Mod+1',
  },
  {
    id: 'app.switchMode.implement',
    labelKey: 'shortcuts.items.switchImplement.label',
    descriptionKey: 'shortcuts.items.switchImplement.description',
    category: 'mode',
    label: 'Switch to Implement mode',
    description: 'Switch active mode to Implement',
    defaultBinding: 'Mod+2',
  },
  {
    id: 'app.switchMode.chat',
    labelKey: 'shortcuts.items.switchChat.label',
    descriptionKey: 'shortcuts.items.switchChat.description',
    category: 'mode',
    label: 'Switch to Chat mode',
    description: 'Switch active mode to Chat',
    defaultBinding: 'Mod+3',
  },
  {
    id: 'app.toggleLeftPanel',
    labelKey: 'shortcuts.items.toggleLeftPanel.label',
    descriptionKey: 'shortcuts.items.toggleLeftPanel.description',
    category: 'layout',
    label: 'Toggle left panel',
    description: 'Show or hide the left panel',
    defaultBinding: 'Mod+[',
  },
  {
    id: 'app.toggleRightPanel',
    labelKey: 'shortcuts.items.toggleRightPanel.label',
    descriptionKey: 'shortcuts.items.toggleRightPanel.description',
    category: 'layout',
    label: 'Toggle right panel',
    description: 'Show or hide the right panel',
    defaultBinding: 'Mod+]',
  },
  {
    id: 'ai.cycleProvider',
    labelKey: 'shortcuts.items.nextProvider.label',
    descriptionKey: 'shortcuts.items.nextProvider.description',
    category: 'ai',
    label: 'Next provider',
    description: 'Switch to next enabled provider',
    defaultBinding: 'Mod+Shift+P',
  },
  {
    id: 'ai.cycleModel',
    labelKey: 'shortcuts.items.nextModel.label',
    descriptionKey: 'shortcuts.items.nextModel.description',
    category: 'ai',
    label: 'Next model',
    description: 'Switch to next enabled model',
    defaultBinding: 'Mod+Shift+M',
  },
  {
    id: 'chat.stopStreaming',
    labelKey: 'shortcuts.items.stopStreaming.label',
    descriptionKey: 'shortcuts.items.stopStreaming.description',
    category: 'chat',
    label: 'Stop streaming',
    description: 'Stop the current assistant response',
    defaultBinding: 'Mod+.',
  },
  {
    id: 'chat.focusInput',
    labelKey: 'shortcuts.items.focusInput.label',
    descriptionKey: 'shortcuts.items.focusInput.description',
    category: 'chat',
    label: 'Focus chat input',
    description: 'Move cursor to chat composer',
    defaultBinding: 'Mod+/',
  },
  {
    id: 'chat.secondarySend',
    labelKey: 'shortcuts.items.secondarySend.label',
    descriptionKey: 'shortcuts.items.secondarySend.description',
    category: 'chat',
    label: 'Secondary composer action',
    description: 'Use the alternate action while a response is running',
    defaultBinding: 'Mod+Enter',
    allowInEditable: true,
  },
  {
    id: 'chat.historyPrevious',
    labelKey: 'shortcuts.items.historyPrevious.label',
    descriptionKey: 'shortcuts.items.historyPrevious.description',
    category: 'chat',
    label: 'Prompt history previous',
    description: 'Navigate to the previous prompt in chat input',
    defaultBinding: 'Mod+ArrowUp',
    allowInEditable: true,
  },
  {
    id: 'chat.historyNext',
    labelKey: 'shortcuts.items.historyNext.label',
    descriptionKey: 'shortcuts.items.historyNext.description',
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
