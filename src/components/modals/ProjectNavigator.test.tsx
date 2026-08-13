import React from 'react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore } from '../../stores/useAppStore';
import type { Project, ProjectGroup } from '../../types';

let latestDndContextProps: {
  onDragStart?: (event: unknown) => void;
  onDragEnd?: (event: unknown) => void;
  onDragCancel?: () => void;
} | null = null;
let shouldRenderProjectOpenActionMock = mock(() => false);

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOptions?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
      const fallback = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : _key;
      const interpolation = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : options;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_match, key) =>
        String(interpolation?.[key] ?? '')
      );
    },
  }),
}));

mock.module('@dnd-kit/core', () => ({
  DndContext: (props: {
    children: React.ReactNode;
    onDragStart?: (event: unknown) => void;
    onDragEnd?: (event: unknown) => void;
    onDragCancel?: () => void;
  }) => {
    latestDndContextProps = props;
    return <div>{props.children}</div>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: function PointerSensor() {},
  closestCenter: mock(() => null),
  useDraggable: mock(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: mock(() => undefined),
    isDragging: false,
  })),
  useDroppable: mock(() => ({
    setNodeRef: mock(() => undefined),
    isOver: false,
  })),
  useSensor: mock(() => ({})),
  useSensors: mock((...sensors: unknown[]) => sensors),
}));

mock.module('../../services', () => ({
  getServiceRuntimeCapabilities: () => ({
    projectMutation: true,
  }),
}));

mock.module('../../services/projectOpeners', () => ({
  getEmptyProjectOpenSelection: () => ({ editor: null, terminal: null, files: null }),
  loadProjectOpenSettings: mock(async () => ({
    selectedAppIdsByAction: { editor: null, terminal: null, files: null },
  })),
  openProjectInExternalApp: mock(async () => undefined),
  PROJECT_OPEN_ACTIONS: ['editor', 'terminal', 'files'],
  shouldRenderProjectOpenAction: (...args: unknown[]) =>
    (shouldRenderProjectOpenActionMock as (...callArgs: unknown[]) => unknown)(...args),
}));

const makeProject = (id: string, name = id): Project => ({
  id,
  name,
  mountName: id,
  path: `/tmp/${id}`,
  created_at: '2026-05-31T00:00:00.000Z',
  status: 'active',
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
});

const makeGroup = (): ProjectGroup => ({
  id: 'group-main',
  name: 'Suite',
  isOpen: true,
  projects: [makeProject('project-api', 'API'), makeProject('project-web', 'Web')],
});

const clickProject = async (projectId: string) => {
  const target = document.body.querySelector(`[data-project-id="${projectId}"]`);
  expect(target).toBeDefined();

  await act(async () => {
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
};

const openProjectMenu = async (projectId: string) => {
  const target = document.body.querySelector(`[data-project-id="${projectId}"]`);
  expect(target).toBeDefined();
  const menuButton = target!.querySelector('[data-project-nav-menu="true"]') as HTMLButtonElement | null;
  expect(menuButton).toBeDefined();

  await act(async () => {
    menuButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
};

const findButton = (text: string): HTMLButtonElement => {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
};

const changeInput = async (placeholder: string, value: string) => {
  const input = Array.from(document.body.querySelectorAll('input')).find(
    (candidate) => candidate.getAttribute('placeholder') === placeholder
  ) as HTMLInputElement | undefined;
  expect(input).toBeDefined();
  const reactPropsKey = Object.keys(input!).find((key) => key.startsWith('__reactProps$'));
  expect(reactPropsKey).toBeDefined();
  const reactProps = (input! as unknown as Record<string, { onChange?: (event: unknown) => void }>)[
    reactPropsKey!
  ];
  await act(async () => {
    reactProps.onChange?.({ target: { value } });
    await Promise.resolve();
  });
  return input!;
};

const pressInputKey = async (placeholder: string, key: string) => {
  const input = Array.from(document.body.querySelectorAll('input')).find(
    (candidate) => candidate.getAttribute('placeholder') === placeholder
  ) as HTMLInputElement | undefined;
  expect(input).toBeDefined();
  const reactPropsKey = Object.keys(input!).find((candidate) => candidate.startsWith('__reactProps$'));
  expect(reactPropsKey).toBeDefined();
  const reactProps = (input! as unknown as Record<string, { onKeyDown?: (event: unknown) => void }>)[
    reactPropsKey!
  ];
  await act(async () => {
    reactProps.onKeyDown?.({
      key,
      preventDefault: mock(() => undefined),
    });
    await Promise.resolve();
  });
};

describe('ProjectNavigator', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let closeMock = mock(() => undefined);
  let createProjectGroupMock = mock(async (_name: string, _projectIds: string[]) => undefined);
  let moveProjectToGroupMock = mock(async (_projectId: string, _groupId: string | null) => undefined);

  beforeEach(() => {
    latestDndContextProps = null;
    shouldRenderProjectOpenActionMock = mock(() => false);
    closeMock = mock(() => undefined);
    createProjectGroupMock = mock(async (_name: string, _projectIds: string[]) => undefined);
    moveProjectToGroupMock = mock(async (_projectId: string, _groupId: string | null) => undefined);
    useAppStore.setState({
      standaloneProjects: [makeProject('project-solo', 'Solo')],
      projectGroups: [makeGroup()],
      selectedGroupId: null,
      selectedProjectId: null,
      isLoading: false,
      projectRegistryRepairSummary: null,
      createProjectGroup: createProjectGroupMock as never,
      moveProjectToGroup: moveProjectToGroupMock as never,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    container = null;
    root = null;
  });

  const renderNavigator = async () => {
    const { ProjectNavigator } = await import('./ProjectNavigator');
    await act(async () => {
      root?.render(<ProjectNavigator isOpen onClose={closeMock} />);
      await Promise.resolve();
    });
  };

  it('renders standalone projects at the root before groups', async () => {
    await renderNavigator();

    const text = document.body.textContent ?? '';
    expect(text.indexOf('Solo')).toBeLessThan(text.indexOf('Suite'));
  });

  it('selects standalone projects alone and grouped projects as their group', async () => {
    await renderNavigator();

    await clickProject('project-solo');
    expect(useAppStore.getState().selectedGroupId).toBeNull();
    expect(useAppStore.getState().selectedProjectId).toBe('project-solo');

    await renderNavigator();
    await clickProject('project-api');
    expect(useAppStore.getState().selectedGroupId).toBe('group-main');
    expect(useAppStore.getState().selectedProjectId).toBeNull();
  });

  it('does not render a selected state on projects inside a selected group', async () => {
    useAppStore.setState({
      selectedGroupId: 'group-main',
      selectedProjectId: 'project-web',
    });

    await renderNavigator();

    const groupedProject = document.body.querySelector('[data-project-id="project-web"]');
    expect(groupedProject).toBeDefined();
    expect(groupedProject!.className).not.toContain('border-primary/30');
    expect(groupedProject!.className).not.toContain('bg-primary/10');
  });

  it('keeps the selected state on standalone projects', async () => {
    useAppStore.setState({
      selectedGroupId: null,
      selectedProjectId: 'project-solo',
    });

    await renderNavigator();

    const standaloneProject = document.body.querySelector('[data-project-id="project-solo"]');
    expect(standaloneProject).toBeDefined();
    expect(standaloneProject!.className).toContain('border-primary/30');
    expect(standaloneProject!.className).toContain('bg-primary/10');
  });

  it('shows quick project actions only on row hover, not focus', async () => {
    shouldRenderProjectOpenActionMock = mock(() => true);

    await renderNavigator();

    const project = document.body.querySelector('[data-project-id="project-solo"]');
    expect(project).toBeDefined();
    const actions = Array.from(project!.querySelectorAll('div')).find((candidate) =>
      candidate.className.includes('group-hover:opacity-100')
    );
    expect(actions).toBeDefined();
    expect(actions!.className).toContain('pointer-events-none');
    expect(actions!.className).toContain('group-hover:pointer-events-auto');
    expect(actions!.className).toContain('group-hover:opacity-100');
    expect(actions!.className).not.toContain('group-focus-within:opacity-100');
  });

  it('creates a group inline from the manual action', async () => {
    useAppStore.setState({
      standaloneProjects: [
        makeProject('project-solo', 'Solo'),
        makeProject('project-docs', 'Docs'),
      ],
      projectGroups: [],
    });
    await renderNavigator();

    expect(
      Array.from(document.body.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'Create group'
      )
    ).toBe(false);

    await openProjectMenu('project-solo');

    await act(async () => {
      findButton('Create group').click();
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-inline-group-draft="true"]')).toBeDefined();
    await changeInput('Group name', 'Workspace');
    await pressInputKey('Group name', 'Enter');

    expect(createProjectGroupMock).toHaveBeenCalledWith('Workspace', [
      'project-solo',
      'project-docs',
    ]);
  });

  it('drops one standalone project onto another and creates an inline draft', async () => {
    useAppStore.setState({
      standaloneProjects: [
        makeProject('project-solo', 'Solo'),
        makeProject('project-docs', 'Docs'),
      ],
      projectGroups: [],
    });
    await renderNavigator();

    await act(async () => {
      latestDndContextProps?.onDragStart?.({
        active: {
          id: 'project:project-solo',
          data: { current: { type: 'project', projectId: 'project-solo', groupId: null } },
        },
      });
      latestDndContextProps?.onDragEnd?.({
        active: {
          id: 'project:project-solo',
          data: { current: { type: 'project', projectId: 'project-solo', groupId: null } },
        },
        over: {
          id: 'project-drop:project-docs',
          data: { current: { type: 'project', projectId: 'project-docs', groupId: null } },
        },
      });
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-inline-group-draft="true"]')).toBeDefined();
    expect(document.body.textContent).toContain('Solo');
    expect(document.body.textContent).toContain('Docs');

    await changeInput('Group name', 'Workspace');
    await pressInputKey('Group name', 'Enter');

    expect(createProjectGroupMock).toHaveBeenCalledWith('Workspace', [
      'project-solo',
      'project-docs',
    ]);
  });

  it('clears the drag overlay when a drag is cancelled', async () => {
    await renderNavigator();

    await act(async () => {
      latestDndContextProps?.onDragStart?.({
        active: {
          id: 'project:project-solo',
          data: { current: { type: 'project', projectId: 'project-solo', groupId: null } },
        },
      });
    });
    expect(document.body.querySelector('[data-drag-overlay="true"]')).not.toBeNull();

    await act(async () => {
      latestDndContextProps?.onDragCancel?.();
    });

    expect(document.body.querySelector('[data-drag-overlay="true"]')).toBeNull();
  });

  it('hides draft projects and edits the draft by drag and drop before confirming', async () => {
    useAppStore.setState({
      standaloneProjects: [
        makeProject('project-solo', 'Solo'),
        makeProject('project-docs', 'Docs'),
        makeProject('project-macro', 'Macro'),
      ],
      projectGroups: [],
    });
    await renderNavigator();

    await act(async () => {
      latestDndContextProps?.onDragEnd?.({
        active: {
          id: 'project:project-solo',
          data: { current: { type: 'project', projectId: 'project-solo', groupId: null } },
        },
        over: {
          id: 'project-drop:project-docs',
          data: { current: { type: 'project', projectId: 'project-docs', groupId: null } },
        },
      });
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-inline-group-draft="true"]')).toBeDefined();
    expect(document.body.querySelector('[data-project-id="project-solo"]')).toBeNull();
    expect(document.body.querySelector('[data-project-id="project-docs"]')).toBeNull();
    expect(document.body.querySelector('[data-project-id="project-macro"]')).toBeDefined();

    await act(async () => {
      latestDndContextProps?.onDragEnd?.({
        active: {
          id: 'project:project-macro',
          data: { current: { type: 'project', projectId: 'project-macro', groupId: null } },
        },
        over: {
          id: 'inline-group-draft-drop',
          data: { current: { type: 'inline-group-draft' } },
        },
      });
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-project-id="project-macro"]')).toBeNull();

    await act(async () => {
      latestDndContextProps?.onDragEnd?.({
        active: {
          id: 'project:project-docs',
          data: { current: { type: 'project', projectId: 'project-docs', groupId: null } },
        },
        over: {
          id: 'standalone-drop',
          data: { current: { type: 'standalone-root' } },
        },
      });
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-project-id="project-docs"]')).toBeDefined();
    await changeInput('Group name', 'Workspace');
    await pressInputKey('Group name', 'Enter');

    expect(createProjectGroupMock).toHaveBeenCalledWith('Workspace', [
      'project-solo',
      'project-macro',
    ]);
  });

  it('moves projects by dropping onto groups or the standalone root', async () => {
    await renderNavigator();

    await act(async () => {
      latestDndContextProps?.onDragEnd?.({
        active: {
          id: 'project:project-solo',
          data: { current: { type: 'project', projectId: 'project-solo', groupId: null } },
        },
        over: {
          id: 'group-drop:group-main',
          data: { current: { type: 'group', groupId: 'group-main' } },
        },
      });
      await Promise.resolve();
    });

    expect(moveProjectToGroupMock).toHaveBeenCalledWith('project-solo', 'group-main');

    await act(async () => {
      latestDndContextProps?.onDragEnd?.({
        active: {
          id: 'project:project-api',
          data: { current: { type: 'project', projectId: 'project-api', groupId: 'group-main' } },
        },
        over: {
          id: 'standalone-drop',
          data: { current: { type: 'standalone-root' } },
        },
      });
      await Promise.resolve();
    });

    expect(moveProjectToGroupMock).toHaveBeenCalledWith('project-api', null);
  });
});
