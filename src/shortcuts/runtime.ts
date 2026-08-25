import { shortcutDefinitionsById, type ShortcutDefinition, type ShortcutId } from './catalog';
import type { PromptHistoryNavigationMode } from '../stores/useShortcutsStore';
import type { AppMode } from '../types';

export const CHAT_INPUT_SELECTOR = '[data-shortcut-chat-input="true"]';

interface ConversationRuntime {
  phase: string;
}

export interface ShortcutAvailabilityContext {
  editable: boolean;
  isChatInputFocused: boolean;
  isStreaming: boolean;
  mode: AppMode;
  promptHistoryNavigationMode: PromptHistoryNavigationMode;
  settingsOpen: boolean;
}

export interface ShortcutAppState {
  settingsOpen: boolean;
  mode: AppMode;
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  setMode: (mode: AppMode) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
}

export interface ShortcutChatState {
  selectedConversationId: string | null;
  createConversation: (
    title: string,
    taskId: string | null,
    projectId: string | null
  ) => Promise<unknown>;
  stopStreaming: () => void;
  getConversationRuntime: (conversationId: string) => ConversationRuntime;
}

export interface ShortcutProviderState {
  cycleProvider: () => void;
  cycleModel: () => void;
}

export interface ShortcutHandlerContext {
  appState: ShortcutAppState;
  chatState: ShortcutChatState;
  providerState: ShortcutProviderState;
  document: Document;
  window: Window;
}

export type ShortcutUnavailableReason =
  | 'disabledInEditable'
  | 'settingsClosed'
  | 'settingsOpen'
  | 'wrongMode'
  | 'notStreaming'
  | 'promptHistoryContextualMode'
  | 'composerNotFocused';

export type ShortcutAvailabilityReason = 'available' | ShortcutUnavailableReason;

export interface ShortcutAvailabilityResult {
  available: boolean;
  reason: ShortcutAvailabilityReason;
}

export type ShortcutContextHint =
  | 'settingsOpen'
  | 'chatMode'
  | 'outsideSettings'
  | 'streaming'
  | 'composerShortcutMode';

export interface ShortcutActivationConstraints {
  editable?: boolean;
  isChatInputFocused?: boolean;
  isStreaming?: boolean;
  mode?: AppMode;
  promptHistoryNavigationMode?: PromptHistoryNavigationMode;
  settingsOpen?: boolean;
}

type ShortcutHandler = (context: ShortcutHandlerContext) => boolean;

export interface ShortcutRuntimeDefinition {
  definition: ShortcutDefinition;
  constraints: ShortcutActivationConstraints;
  contextHints: ShortcutContextHint[];
  handler: ShortcutHandler;
}

const unavailableResult = (reason: ShortcutUnavailableReason): ShortcutAvailabilityResult => ({
  available: false,
  reason,
});

const availableResult: ShortcutAvailabilityResult = {
  available: true,
  reason: 'available',
};

const createRuntimeDefinition = (
  id: ShortcutId,
  runtime: Omit<ShortcutRuntimeDefinition, 'definition'>
): ShortcutRuntimeDefinition => ({
  definition: shortcutDefinitionsById[id],
  ...runtime,
});

export const shortcutRuntimeDefinitions: Record<ShortcutId, ShortcutRuntimeDefinition> = {
  'app.openSettings': createRuntimeDefinition('app.openSettings', {
    constraints: {},
    contextHints: [],
    handler: ({ appState }) => {
      appState.openSettings();
      return true;
    },
  }),
  'app.closeSettings': createRuntimeDefinition('app.closeSettings', {
    constraints: { settingsOpen: true },
    contextHints: ['settingsOpen'],
    handler: ({ appState }) => {
      if (!appState.settingsOpen) return false;
      appState.closeSettings();
      return true;
    },
  }),
  'chat.newConversation': createRuntimeDefinition('chat.newConversation', {
    constraints: { mode: 'Chat' },
    contextHints: ['chatMode'],
    handler: ({ chatState }) => {
      void chatState.createConversation('New Conversation', null, null);
      return true;
    },
  }),
  'app.switchMode.architect': createRuntimeDefinition('app.switchMode.architect', {
    constraints: { settingsOpen: false },
    contextHints: ['outsideSettings'],
    handler: ({ appState }) => {
      appState.setMode('Architect');
      return true;
    },
  }),
  'app.switchMode.implement': createRuntimeDefinition('app.switchMode.implement', {
    constraints: { settingsOpen: false },
    contextHints: ['outsideSettings'],
    handler: ({ appState }) => {
      appState.setMode('Implement');
      return true;
    },
  }),
  'app.switchMode.chat': createRuntimeDefinition('app.switchMode.chat', {
    constraints: { settingsOpen: false },
    contextHints: ['outsideSettings'],
    handler: ({ appState }) => {
      appState.setMode('Chat');
      return true;
    },
  }),
  'app.toggleLeftPanel': createRuntimeDefinition('app.toggleLeftPanel', {
    constraints: {},
    contextHints: [],
    handler: ({ appState }) => {
      appState.setLeftPanelOpen(!appState.isLeftPanelOpen);
      return true;
    },
  }),
  'app.toggleRightPanel': createRuntimeDefinition('app.toggleRightPanel', {
    constraints: {},
    contextHints: [],
    handler: ({ appState }) => {
      appState.setRightPanelOpen(!appState.isRightPanelOpen);
      return true;
    },
  }),
  'ai.cycleProvider': createRuntimeDefinition('ai.cycleProvider', {
    constraints: {},
    contextHints: [],
    handler: ({ providerState }) => {
      providerState.cycleProvider();
      return true;
    },
  }),
  'ai.cycleModel': createRuntimeDefinition('ai.cycleModel', {
    constraints: {},
    contextHints: [],
    handler: ({ providerState }) => {
      providerState.cycleModel();
      return true;
    },
  }),
  'chat.stopStreaming': createRuntimeDefinition('chat.stopStreaming', {
    constraints: { isStreaming: true },
    contextHints: ['streaming'],
    handler: ({ chatState }) => {
      if (!chatState.selectedConversationId) return false;
      if (chatState.getConversationRuntime(chatState.selectedConversationId).phase !== 'streaming') {
        return false;
      }
      chatState.stopStreaming();
      return true;
    },
  }),
  'chat.focusInput': createRuntimeDefinition('chat.focusInput', {
    constraints: {},
    contextHints: [],
    handler: ({ document }) => {
      const element = document.querySelector<HTMLElement>(CHAT_INPUT_SELECTOR);
      if (!element) return false;
      element.focus();
      return true;
    },
  }),
  'chat.secondarySend': createRuntimeDefinition('chat.secondarySend', {
    constraints: { isChatInputFocused: true, isStreaming: true },
    contextHints: ['streaming'],
    handler: ({ window }) => {
      window.dispatchEvent(new CustomEvent('macro:composer-secondary-send'));
      return true;
    },
  }),
  'chat.historyPrevious': createRuntimeDefinition('chat.historyPrevious', {
    constraints: { isChatInputFocused: true, promptHistoryNavigationMode: 'shortcut_only' },
    contextHints: ['composerShortcutMode'],
    handler: ({ window }) => {
      window.dispatchEvent(
        new CustomEvent('macro:prompt-history', { detail: { direction: 'up' } })
      );
      return true;
    },
  }),
  'chat.historyNext': createRuntimeDefinition('chat.historyNext', {
    constraints: { isChatInputFocused: true, promptHistoryNavigationMode: 'shortcut_only' },
    contextHints: ['composerShortcutMode'],
    handler: ({ window }) => {
      window.dispatchEvent(
        new CustomEvent('macro:prompt-history', { detail: { direction: 'down' } })
      );
      return true;
    },
  }),
};

export const shortcutHandlers: Record<ShortcutId, ShortcutHandler> = Object.fromEntries(
  Object.entries(shortcutRuntimeDefinitions).map(([id, runtime]) => [id, runtime.handler])
) as Record<ShortcutId, ShortcutHandler>;

const getEffectiveShortcutConstraints = (
  runtime: ShortcutRuntimeDefinition,
  options: { includeImpliedEditable?: boolean } = {}
): ShortcutActivationConstraints => {
  const constraints = { ...runtime.constraints };
  if (!runtime.definition.allowInEditable) {
    constraints.editable = false;
  } else if (options.includeImpliedEditable && constraints.isChatInputFocused === true) {
    constraints.editable = true;
  }
  return constraints;
};

const getConstraintMismatchReason = (
  key: keyof ShortcutActivationConstraints,
  expected: ShortcutActivationConstraints[keyof ShortcutActivationConstraints],
  actual: ShortcutActivationConstraints[keyof ShortcutActivationConstraints]
): ShortcutUnavailableReason | null => {
  if (expected === undefined || expected === actual) return null;

  switch (key) {
    case 'editable':
      return 'disabledInEditable';
    case 'settingsOpen':
      return expected ? 'settingsClosed' : 'settingsOpen';
    case 'mode':
      return 'wrongMode';
    case 'isStreaming':
      return 'notStreaming';
    case 'promptHistoryNavigationMode':
      return 'promptHistoryContextualMode';
    case 'isChatInputFocused':
      return 'composerNotFocused';
    default:
      return null;
  }
};

const availabilityConstraintOrder: Array<keyof ShortcutActivationConstraints> = [
  'editable',
  'settingsOpen',
  'mode',
  'isStreaming',
  'promptHistoryNavigationMode',
  'isChatInputFocused',
];

export const getShortcutAvailability = (
  shortcutId: ShortcutId,
  context: ShortcutAvailabilityContext
): ShortcutAvailabilityResult => {
  const runtime = shortcutRuntimeDefinitions[shortcutId];
  const constraints = getEffectiveShortcutConstraints(runtime);

  for (const key of availabilityConstraintOrder) {
    const reason = getConstraintMismatchReason(key, constraints[key], context[key]);
    if (reason) return unavailableResult(reason);
  }

  return availableResult;
};

export const isShortcutAvailable = (
  definition: ShortcutDefinition,
  context: ShortcutAvailabilityContext
): boolean => getShortcutAvailability(definition.id, context).available;

export const shortcutsCanConflict = (leftId: ShortcutId, rightId: ShortcutId): boolean => {
  const leftConstraints = getEffectiveShortcutConstraints(shortcutRuntimeDefinitions[leftId], {
    includeImpliedEditable: true,
  });
  const rightConstraints = getEffectiveShortcutConstraints(shortcutRuntimeDefinitions[rightId], {
    includeImpliedEditable: true,
  });

  for (const key of availabilityConstraintOrder) {
    const left = leftConstraints[key];
    const right = rightConstraints[key];
    if (left !== undefined && right !== undefined && left !== right) {
      return false;
    }
  }

  return true;
};

export const executeShortcut = (
  shortcutId: ShortcutId,
  context: ShortcutHandlerContext
): boolean => shortcutHandlers[shortcutId](context);
