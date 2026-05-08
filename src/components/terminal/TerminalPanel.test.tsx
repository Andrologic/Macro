import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TerminalPanel as TerminalPanelComponent } from './TerminalPanel';

type MockTerminalTab = {
  id: string;
  kind: string;
  taskId: string | null;
  projectId: string;
  projectName: string;
  mountName: string;
  workspacePath: string;
  cwd: string;
  title: string;
  status: string;
  snapshot: string;
  lastCommand: string | null;
  lastExitCode: number | null;
  hasLiveSession: boolean;
  isRestored: boolean;
  hasUnreadOutput: boolean;
  createdAt: string;
  updatedAt: string;
};

const buildTab = (overrides: Partial<MockTerminalTab> = {}): MockTerminalTab => ({
  id: 'terminal-tab-1',
  kind: 'manual',
  taskId: 'task-1',
  projectId: 'project-1',
  projectName: 'Web',
  mountName: 'web',
  workspacePath: '/repo/web',
  cwd: '/repo/web',
  title: 'web - Terminal',
  status: 'idle',
  snapshot: '',
  lastCommand: null,
  lastExitCode: null,
  hasLiveSession: true,
  isRestored: false,
  hasUnreadOutput: false,
  createdAt: '2026-05-08T10:00:00.000Z',
  updatedAt: '2026-05-08T10:00:00.000Z',
  ...overrides,
});

const terminalState = {
  tabs: {} as Record<string, MockTerminalTab>,
  tabOrder: ['terminal-tab-1'],
  activeTabId: 'terminal-tab-1' as string | null,
  activeTabIdByScope: { 'task-1:project-1': 'terminal-tab-1' } as Record<string, string>,
  activateTab: mock(() => undefined),
  createManualTab: mock(async () => undefined),
  openManualTabForProject: mock(async () => undefined),
  rememberManualProjectForTask: mock(() => undefined),
  lastManualProjectIdByTaskId: {} as Record<string, string>,
  reconnectTab: mock(async () => undefined),
  writeInput: mock(async () => undefined),
  resizeTab: mock(async () => undefined),
  interruptTab: mock(async () => buildTab()),
  clearTab: mock(async () => buildTab()),
  closeTab: mock(async () => undefined),
};

const appState = {
  selectedGroupId: 'group-1',
  selectedProjectId: 'project-1',
  selectedTaskId: 'task-1',
  setSelectedProject: mock(() => undefined),
  projectGroups: [
    {
      id: 'group-1',
      name: 'Macro',
      projects: [{ id: 'project-1', name: 'Web', mountName: 'web', path: '/repo/web' }],
    },
  ],
};

const taskState = {
  tasks: [
    {
      id: 'task-1',
      title: 'Terminal task',
      status: 'Pending',
      draft: false,
      task_source: 'architect',
      standalone_kind: 'legacy',
    },
  ],
};

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
};

let TerminalPanel!: typeof TerminalPanelComponent;
let importCounter = 0;

const loadTerminalPanel = async () => {
  importCounter += 1;
  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key,
    }),
  }));
  mock.module('../ui/toastService', () => ({
    notify: {
      error: mock(() => undefined),
    },
  }));
  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));
  mock.module('./TerminalViewport', () => ({
    TerminalViewport: ({ onClear }: { onClear?: () => void }) => (
      <button type="button" data-testid="mock-terminal-viewport" onClick={onClear}>
        viewport
      </button>
    ),
  }));
  mock.module('./TerminalTargetSplitButton', () => ({
    default: ({ title }: { title?: string }) => <button type="button">{title}</button>,
  }));
  mock.module('../../services/terminalRuntime', () => ({
    default: {
      disposeTab: mock(() => undefined),
    },
  }));
  mock.module('../../services/manualTerminalTargets', () => ({
    getTerminalScopeKey: (taskId: string | null, projectId: string | null) =>
      `${taskId ?? 'none'}:${projectId ?? 'none'}`,
    resolveSelectedTaskTerminalScope: () => ({
      taskId: 'task-1',
      projectId: 'project-1',
      groupId: 'group-1',
      projects: appState.projectGroups[0].projects,
      preferredProjectId: 'project-1',
    }),
  }));
  mock.module('../../services/manualDraftInitialization', () => ({
    isManualDraftPendingInitialization: () => false,
  }));
  mock.module('../../stores/useTerminalStore', () => ({
    useTerminalStore: <TSelected,>(selector: (state: typeof terminalState) => TSelected) =>
      selector(terminalState),
  }));
  mock.module('../../stores/useAppStore', () => ({
    useAppStore: <TSelected,>(selector: (state: typeof appState) => TSelected) =>
      selector(appState),
  }));
  mock.module('../../stores/useTaskStore', () => ({
    useTaskStore: <TSelected,>(selector: (state: typeof taskState) => TSelected) =>
      selector(taskState),
  }));

  ({ TerminalPanel } = await import(`./TerminalPanel.tsx?terminal-panel-test=${importCounter}`));
};

describe('TerminalPanel', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    mock.restore();
    terminalState.tabs = { 'terminal-tab-1': buildTab() };
    terminalState.tabOrder = ['terminal-tab-1'];
    terminalState.activeTabId = 'terminal-tab-1';
    terminalState.activeTabIdByScope = { 'task-1:project-1': 'terminal-tab-1' };
    terminalState.clearTab.mockClear();
    terminalState.interruptTab.mockClear();
    await loadTerminalPanel();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    mock.restore();
    root = null;
    container = null;
  });

  it('wires clear and interrupt actions for live terminal tabs', async () => {
    await act(async () => {
      root?.render(<TerminalPanel />);
      await flushRender();
    });

    const clearButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear terminal"]'
    );
    const interruptButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Interrupt terminal"]'
    );

    expect(clearButton?.disabled).toBe(false);
    expect(interruptButton?.disabled).toBe(false);

    await act(async () => {
      clearButton?.click();
      interruptButton?.click();
      await flushRender();
    });

    expect(terminalState.clearTab).toHaveBeenCalledWith('terminal-tab-1');
    expect(terminalState.interruptTab).toHaveBeenCalledWith('terminal-tab-1');
  });

  it('disables clear and interrupt actions for restored terminal tabs', async () => {
    terminalState.tabs = {
      'terminal-tab-1': buildTab({ hasLiveSession: false, isRestored: true }),
    };

    await act(async () => {
      root?.render(<TerminalPanel />);
      await flushRender();
    });

    expect(
      container?.querySelector<HTMLButtonElement>('button[aria-label="Clear terminal"]')?.disabled
    ).toBe(true);
    expect(
      container?.querySelector<HTMLButtonElement>('button[aria-label="Interrupt terminal"]')
        ?.disabled
    ).toBe(true);
  });

  it('passes Ctrl-L clear requests from the viewport to the store', async () => {
    await act(async () => {
      root?.render(<TerminalPanel />);
      await flushRender();
    });

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[data-testid="mock-terminal-viewport"]')?.click();
      await flushRender();
    });

    expect(terminalState.clearTab).toHaveBeenCalledWith('terminal-tab-1');
  });
});
