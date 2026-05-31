import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';

type Need = {
  id: string;
  planId?: string;
  title: string;
  category: string;
  priority: string;
};

type AppState = {
  activeArchitectPlanId: string | null;
  architectPlanSwitch: {
    status: 'idle';
    targetPlanId: null;
    summaryHint: null;
  };
  standaloneProjects: Array<{
    id: string;
    name: string;
    mountName: string;
    path: string;
    status: 'active';
  }>;
  projectGroups: unknown[];
  selectedGroupId: string | null;
  selectedProjectId: string | null;
};

type NeedsState = {
  needs: Need[];
  selectedNeedId: string | null;
  selectNeed: ReturnType<typeof mock>;
};

type ChatMessage = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
};

type ChatState = {
  selectedConversationId: string | null;
  messages: ChatMessage[];
  messagesByConversationId: Record<string, ChatMessage[]>;
  addComposerContextRef: ReturnType<typeof mock>;
};

const createStoreHook = <T extends object,>(
  getSnapshot: () => T,
  setSnapshot: (nextState: T) => void,
) => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return selector ? selector(snapshot) : snapshot;
  }) as ((selector?: (state: T) => unknown) => unknown) & {
    getState: () => T;
    setState: (nextState: Partial<T>) => void;
    emit: () => void;
  };
  hook.getState = getSnapshot;
  hook.emit = () => listeners.forEach((listener) => listener());
  hook.setState = (nextState) => {
    setSnapshot({ ...getSnapshot(), ...nextState });
    hook.emit();
  };
  return hook;
};

let appState: AppState;
let needsState: NeedsState;
let chatState: ChatState;

const useAppStore = createStoreHook(() => appState, (nextState) => {
  appState = nextState;
});
const useNeedsStore = createStoreHook(() => needsState, (nextState) => {
  needsState = nextState;
});
const useChatStore = createStoreHook(() => chatState, (nextState) => {
  chatState = nextState;
});

let NeedsPanel!: typeof import('./NeedsPanel').default;
let importCounter = 0;

const resetState = () => {
  appState = {
    activeArchitectPlanId: 'plan-1',
    architectPlanSwitch: {
      status: 'idle',
      targetPlanId: null,
      summaryHint: null,
    },
    standaloneProjects: [
      {
        id: 'project-1',
        name: 'Project One',
        mountName: 'project-1',
        path: '/tmp/project-1',
        status: 'active',
      },
    ],
    projectGroups: [],
    selectedGroupId: null,
    selectedProjectId: 'project-1',
  };
  needsState = {
    needs: [],
    selectedNeedId: null,
    selectNeed: mock(() => undefined),
  };
  chatState = {
    selectedConversationId: 'conv-1',
    messages: [],
    messagesByConversationId: {},
    addComposerContextRef: mock(() => undefined),
  };
};

const loadNeedsPanelModule = async () => {
  importCounter += 1;
  mock.restore();
  installReactI18nextMock(createTranslationMock());

  mock.module('../../stores/useAppStore', () => ({
    useAppStore,
  }));
  mock.module('../../stores/useNeedsStore', () => ({
    useNeedsStore,
  }));
  mock.module('../../stores/useChatStore', () => ({
    useChatStore,
  }));
  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  ({ default: NeedsPanel } = await import(`./NeedsPanel.tsx?needs-panel-test=${importCounter}`));
};

describe('NeedsPanel', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    await loadNeedsPanelModule();
    resetState();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
    document.body.innerHTML = '';
    mock.restore();
  });

  it('uses the default empty state before the first user explanation', async () => {
    await act(async () => {
      root?.render(<NeedsPanel />);
    });

    expect(document.body.textContent).toContain(
      'Chat with the Architect to uncover project requirements.'
    );
  });

  it('explains that Architect should structure needs after a user explanation', async () => {
    useChatStore.setState({
      messages: [
        {
          id: 'msg-user-1',
          conversation_id: 'conv-1',
          role: 'user',
          content: 'We need to rethink the onboarding plan.',
        },
      ],
    });

    await act(async () => {
      root?.render(<NeedsPanel />);
    });

    expect(document.body.textContent).toContain(
      'Architect should now turn this explanation into structured needs.'
    );
  });
});
