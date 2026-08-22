import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../../test-utils/reactI18nextMock';
import type { ComposerEditorHandle } from './ComposerEditor';
import type { ProjectGroup, SkillManifest, SkillSettings, WorkspaceFileReference } from '../../../types';

const translationMock = createTranslationMock({});

let removeComposerContextRef: ReturnType<typeof mock>;
let addComposerContextRef: ReturnType<typeof mock>;
let loadSettingsMock: ReturnType<typeof mock>;
let refreshSkillsMock: ReturnType<typeof mock>;
let openSettingsMock: ReturnType<typeof mock>;
let composerContextRefs: Array<{
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  data?: unknown;
}>;
let activeArchitectPlanId: string | null;
let skills: SkillManifest[];
let settingsBySkillId: Record<string, SkillSettings>;
let fileSearchResults: WorkspaceFileReference[];
let searchWorkspaceFilesMock: ReturnType<typeof mock>;

const buildSkill = (
  id: string,
  overrides: Partial<SkillManifest> = {},
): SkillManifest => ({
  id,
  name: id.split(':').at(-1) ?? id,
  description: 'Reusable agent guidance',
  rootPath: `/skills/${id.replaceAll(':', '-')}`,
  skillFilePath: `/skills/${id.replaceAll(':', '-')}/SKILL.md`,
  source: id.startsWith('project:')
    ? {
        kind: 'project',
        namespace: 'agents',
        projectId: 'project-1',
        projectName: 'Web',
        rootPath: '/repo/web',
        skillRootPath: '/repo/web/.agents/skills',
      }
    : {
        kind: 'global',
        namespace: 'agents',
        projectId: null,
        projectName: null,
        rootPath: '/Users/test/.agents/skills',
        skillRootPath: '/Users/test/.agents/skills',
      },
  resources: [],
  scripts: [],
  validationErrors: [],
  isValid: true,
  ...overrides,
});

const buildFile = (
  path: string,
  overrides: Partial<WorkspaceFileReference> = {},
): WorkspaceFileReference => ({
  id: `file:project-1:${path}`,
  path,
  relativePath: path,
  projectId: 'project-1',
  projectName: 'Web',
  language: 'TypeScript',
  sizeBytes: 1200,
  modified: '2026-05-01T00:00:00.000Z',
  isFocused: true,
  ...overrides,
});

const projectGroups: ProjectGroup[] = [{
  id: 'group-1',
  name: 'Workspace',
  isOpen: true,
  projects: [{
    id: 'project-1',
    name: 'Web',
    mountName: 'web',
    path: '/repo/web',
    created_at: '2026-05-01T00:00:00.000Z',
    status: 'active',
    metadata: {
      description: '',
      tags: [],
      team_members: [],
      api_contracts: [],
      dependencies: [],
    },
    gitFlowSettings: {
      baseBranch: 'develop',
      mainBranch: 'main',
      planBranchTemplate: 'plan/{slug}',
      featureBranchTemplate: 'feature/{slug}',
      standaloneFeatureBranchTemplate: 'feature/{slug}',
      releaseBranchTemplate: 'release/{version}',
      hotfixBranchTemplate: 'hotfix/{slug}',
      bugfixBranchTemplate: 'bugfix/{slug}',
    },
  }],
}];

const installStoreMock = () => {
  removeComposerContextRef = mock(() => undefined);
  addComposerContextRef = mock((ref: (typeof composerContextRefs)[number]) => {
    if (!composerContextRefs.some((existing) => existing.id === ref.id && existing.kind === ref.kind)) {
      composerContextRefs = [...composerContextRefs, ref];
    }
  });
  const chatState = {
    selectedConversationId: 'conversation-1',
    conversations: [{
      id: 'conversation-1',
      title: 'Chat',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
      scope_mode: 'Implement',
      task_id: null,
      group_id: 'group-1',
      project_id: 'project-1',
      provider_id: null,
      model_id: null,
      reasoning_effort: null,
    }],
    get composerContextRefs() {
      return composerContextRefs;
    },
    addComposerContextRef,
    removeComposerContextRef,
  };
  const useChatStore = ((selector?: (state: typeof chatState) => unknown) =>
    selector ? selector(chatState) : chatState) as typeof import('../../../stores/useChatStore').useChatStore;
  useChatStore.getState = () =>
    chatState as unknown as ReturnType<typeof useChatStore.getState>;

  mock.module('../../../stores/useChatStore', () => ({
    useChatStore,
  }));

  loadSettingsMock = mock(async () => undefined);
  refreshSkillsMock = mock(async () => undefined);
  const skillsState = {
    get skills() {
      return skills;
    },
    get settingsBySkillId() {
      return settingsBySkillId;
    },
    isLoading: false,
    loadSettings: loadSettingsMock,
    refreshSkills: refreshSkillsMock,
  };
  const useSkillsStore = ((selector?: (state: typeof skillsState) => unknown) =>
    selector ? selector(skillsState) : skillsState) as typeof import('../../../stores/useSkillsStore').useSkillsStore;
  useSkillsStore.getState = () =>
    skillsState as unknown as ReturnType<typeof useSkillsStore.getState>;
  mock.module('../../../stores/useSkillsStore', () => ({
    useSkillsStore,
  }));

  const taskState = {
    tasks: [],
    activeRepositoryPath: '/repo/web',
    activeWorkspacePathOverridesByProjectId: {},
    branchWorktrees: {},
  };
  const useTaskStore = ((selector?: (state: typeof taskState) => unknown) =>
    selector ? selector(taskState) : taskState) as typeof import('../../../stores/useTaskStore').useTaskStore;
  useTaskStore.getState = () =>
    taskState as unknown as ReturnType<typeof useTaskStore.getState>;
  mock.module('../../../stores/useTaskStore', () => ({
    useTaskStore,
  }));

  const citationsState = {
    citations: [],
  };
  const useCitationsStore = ((selector?: (state: typeof citationsState) => unknown) =>
    selector ? selector(citationsState) : citationsState) as typeof import('../../../stores/useCitationsStore').useCitationsStore;
  useCitationsStore.getState = () =>
    citationsState as unknown as ReturnType<typeof useCitationsStore.getState>;
  mock.module('../../../stores/useCitationsStore', () => ({
    useCitationsStore,
  }));

  openSettingsMock = mock((_tab?: string) => undefined);
  const appState = {
    mode: 'Implement',
    projectGroups,
    selectedGroupId: 'group-1',
    selectedProjectId: 'project-1',
    selectedTaskId: null,
    get activeArchitectPlanId() {
      return activeArchitectPlanId;
    },
    openSettings: openSettingsMock,
  };
  const useAppStore = ((selector?: (state: typeof appState) => unknown) =>
    selector ? selector(appState) : appState) as typeof import('../../../stores/useAppStore').useAppStore;
  useAppStore.getState = () =>
    appState as unknown as ReturnType<typeof useAppStore.getState>;
  mock.module('../../../stores/useAppStore', () => ({
    useAppStore,
  }));

  searchWorkspaceFilesMock = mock(async () => fileSearchResults);
  mock.module('../../../services/workspaceFileSearch', () => ({
    searchWorkspaceFiles: searchWorkspaceFilesMock,
  }));
  mock.module('./ComposerHistoryPlugin', () => ({
    ComposerHistoryPlugin: () => null,
  }));
};

describe('ComposerEditor context references', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ComposerEditor: typeof import('./ComposerEditor').ComposerEditor;
  let getCollapsedComposerSelectionTextPosition: typeof import('./ComposerEditor').getCollapsedComposerSelectionTextPosition;
  let shouldUsePromptHistoryForPosition: typeof import('./ComposerEditor').shouldUsePromptHistoryForPosition;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    if (!globalThis.requestAnimationFrame) {
      globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 0) as unknown as number;
    }
    if (!globalThis.cancelAnimationFrame) {
      globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
    }
    mock.restore();
    window.localStorage.clear();
    installReactI18nextMock(translationMock);
    composerContextRefs = [];
    activeArchitectPlanId = 'plan-1';
    skills = [];
    settingsBySkillId = {};
    fileSearchResults = [];
    installStoreMock();

    ({
      ComposerEditor,
      getCollapsedComposerSelectionTextPosition,
      shouldUsePromptHistoryForPosition,
    } = await import('./ComposerEditor'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const openSlashMenu = async (
    editorRef: React.RefObject<ComposerEditorHandle | null>,
    text: string,
  ) => {
    await act(async () => {
      editorRef.current?.setText(text);
      await Promise.resolve();
    });
    return document.body.querySelector('[data-slash-context-menu="true"]');
  };

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    document.body.innerHTML = '';
    mock.restore();
  });

  it('round-trips bracketed skill text through a message-edit chip', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Edit message"
          onTextChange={() => undefined}
          onSend={() => undefined}
          surface="message-edit"
          syncContextRefs={false}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('[skill: test-skill] utilise ce skill');
      await Promise.resolve();
    });

    const skillChip = container.querySelector('[data-context-reference-kind="skill"]');
    expect(skillChip).toBeTruthy();
    expect(skillChip?.getAttribute('data-context-reference-surface')).toBe('message-edit');
    expect(skillChip?.textContent).toContain('Skill');
    expect(skillChip?.textContent).toContain('test-skill');
    expect(editorRef.current?.getTextContent()).toBe('[skill: test-skill] utilise ce skill');
  });

  it('keeps the cleanup editor immutable while exposing a scrollable wrapper', async () => {
    await act(async () => {
      root.render(
        <ComposerEditor
          editable
          readOnly
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    const editor = container.querySelector<HTMLElement>('[data-shortcut-chat-input="true"]');
    expect(editor?.getAttribute('contenteditable')).toBe('false');
    expect(editor?.className).toContain('!overflow-visible');
    expect(editor?.parentElement?.className).toContain('overflow-y-auto');
  });

  it('keeps arrow-key navigation as a text range around context chips', async () => {
    const lexical = await import('lexical');
    const { MentionNode, $createMentionNode } = await import(
      `./MentionNode.tsx?mention-navigation-test=${Date.now()}`
    );
    const editor = lexical.createEditor({
      namespace: `MentionNavigationTest-${Date.now()}`,
      nodes: [MentionNode],
      onError: (error) => {
        throw error;
      },
    });

    const updateEditor = (callback: () => void) =>
      new Promise<void>((resolve) => {
        editor.update(callback, { onUpdate: () => resolve() });
      });
    const readSelectionState = () =>
      editor.getEditorState().read(() => {
        const selection = lexical.$getSelection();
        return {
          isNodeSelection: lexical.$isNodeSelection(selection),
          isRangeSelection: lexical.$isRangeSelection(selection),
        };
      });

    await updateEditor(() => {
      const root = lexical.$getRoot();
      root.clear();
      const paragraph = lexical.$createParagraphNode();
      const before = lexical.$createTextNode('A');
      const mention = $createMentionNode('skill', 'test-skill', 'test-skill');
      const after = lexical.$createTextNode('B');
      paragraph.append(before, mention, after);
      root.append(paragraph);
      after.select(0, 0);
    });

    await updateEditor(() => {
      const selection = lexical.$getSelection();
      if (lexical.$isRangeSelection(selection)) {
        selection.modify('move', true, 'character');
      }
    });

    expect(readSelectionState()).toEqual({
      isNodeSelection: false,
      isRangeSelection: true,
    });

    await updateEditor(() => {
      const selection = lexical.$getSelection();
      if (lexical.$isRangeSelection(selection)) {
        selection.modify('move', false, 'character');
      }
    });

    expect(readSelectionState()).toEqual({
      isNodeSelection: false,
      isRangeSelection: true,
    });
  });

  it('calculates absolute prompt-history positions across chips and line breaks', async () => {
    const lexical = await import('lexical');
    const { MentionNode, $createMentionNode } = await import(
      `./MentionNode.tsx?mention-position-test=${Date.now()}`
    );
    const editor = lexical.createEditor({
      namespace: `MentionPositionTest-${Date.now()}`,
      nodes: [MentionNode],
      onError: (error) => {
        throw error;
      },
    });

    const updateEditor = (callback: () => void) =>
      new Promise<void>((resolve) => {
        editor.update(callback, { onUpdate: () => resolve() });
      });
    const readPosition = () =>
      editor.getEditorState().read(() => getCollapsedComposerSelectionTextPosition());

    await updateEditor(() => {
      const root = lexical.$getRoot();
      root.clear();
      const paragraph = lexical.$createParagraphNode();
      const before = lexical.$createTextNode('A');
      const mention = $createMentionNode('skill', 'test-skill', 'test-skill');
      const lineBreak = lexical.$createLineBreakNode();
      const after = lexical.$createTextNode('B');
      paragraph.append(before, mention, lineBreak, after);
      root.append(paragraph);
      before.select(0, 0);
    });

    expect(readPosition()?.offset).toBe(0);

    await updateEditor(() => {
      const root = lexical.$getRoot();
      const paragraph = root.getFirstChild();
      const before = lexical.$isElementNode(paragraph) ? paragraph.getFirstChild() : null;
      if (lexical.$isTextNode(before)) {
        before.select(1, 1);
      }
    });

    expect(readPosition()?.offset).toBe(1);

    await updateEditor(() => {
      const root = lexical.$getRoot();
      root.selectEnd();
    });

    const endPosition = readPosition();
    expect(endPosition).toBeTruthy();
    expect(endPosition?.offset).toBe(endPosition?.total);
  });

  it('uses contextual arrows for prompt history only at text boundaries', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
          onPromptHistory={() => undefined}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('');
      await Promise.resolve();
    });

    expect(shouldUsePromptHistoryForPosition({ offset: 0, total: 0 }, 'up')).toBe(true);
    expect(shouldUsePromptHistoryForPosition({ offset: 0, total: 0 }, 'down')).toBe(true);

    await act(async () => {
      editorRef.current?.setText('hello\nworld');
      await Promise.resolve();
    });

    expect(shouldUsePromptHistoryForPosition({ offset: 11, total: 11 }, 'up')).toBe(false);
    expect(shouldUsePromptHistoryForPosition({ offset: 11, total: 11 }, 'down')).toBe(true);
  });

  it('clears without leaving a collapsed selection at the empty composer start', async () => {
    const onPromptHistory = mock(() => undefined);
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
          onPromptHistory={onPromptHistory}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('hello');
      await Promise.resolve();
      editorRef.current?.clear();
      await Promise.resolve();
    });

    expect(editorRef.current?.getTextContent()).toBe('');
    const editable = container.querySelector('[data-shortcut-chat-input="true"]');
    await act(async () => {
      editable?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onPromptHistory).not.toHaveBeenCalled();

    await act(async () => {
      editorRef.current?.setText('');
      await Promise.resolve();
    });

    await act(async () => {
      editable?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onPromptHistory).toHaveBeenCalledWith('up');
  });

  it('emits one text change for imperative setText and clear calls', async () => {
    const onTextChange = mock((_text: string) => undefined);
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={onTextChange}
          onSend={() => undefined}
        />
      );
      await Promise.resolve();
    });

    onTextChange.mockClear();

    await act(async () => {
      editorRef.current?.setText('hello');
      await Promise.resolve();
    });

    expect(onTextChange.mock.calls.map((call) => call[0])).toEqual(['hello']);

    onTextChange.mockClear();

    await act(async () => {
      editorRef.current?.clear();
      await Promise.resolve();
    });

    expect(onTextChange.mock.calls.map((call) => call[0])).toEqual(['']);
  });

  it('preserves context refs when imperative text replacement removes mention nodes', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();
    const ref = {
      kind: 'skill',
      id: 'global:agents:repo-auditor:hash',
      title: 'repo-auditor',
      data: buildSkill('global:agents:repo-auditor:hash', { name: 'repo-auditor' }),
    } as const;
    composerContextRefs = [ref];

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
      await Promise.resolve();
    });

    removeComposerContextRef.mockClear();
    await act(async () => {
      editorRef.current?.setText('A replacement without the mention');
      await Promise.resolve();
    });

    expect(removeComposerContextRef).not.toHaveBeenCalled();
    expect(composerContextRefs).toEqual([ref]);
  });

  it('removes a mention by its stable id when titles are not unique', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();
    const ref = {
      kind: 'skill',
      id: 'global:agents:first-skill:hash',
      title: 'Shared title',
      data: buildSkill('global:agents:first-skill:hash', { name: 'Shared title' }),
    } as const;
    composerContextRefs = [ref];

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      editorRef.current?.setText('[skill: Shared title]');
      await Promise.resolve();
    });

    const removeButton = container.querySelector(
      '[data-context-reference-kind="skill"] button',
    );
    expect(removeButton).not.toBeNull();
    await act(async () => {
      removeButton?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });

    expect(removeComposerContextRef).toHaveBeenCalledWith(ref.id, ref.kind);
  });

  it('removes composer refs with hyphenated kinds and ids without leaving a chip', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();
    const renderComposer = () => (
      <ComposerEditor
        ref={editorRef}
        editable
        placeholder="Message"
        onTextChange={() => undefined}
        onSend={() => undefined}
      />
    );

    composerContextRefs = [{
      kind: 'plan-node',
      id: 'plan-node-alpha-beta',
      title: 'Plan node alpha',
      data: {},
    }];

    await act(async () => {
      root.render(renderComposer());
      await Promise.resolve();
    });

    expect(container.querySelector('[data-context-reference-kind="plan-node"]')).not.toBeNull();

    composerContextRefs = [];
    await act(async () => {
      root.render(renderComposer());
      await Promise.resolve();
    });

    expect(container.querySelector('[data-context-reference-kind="plan-node"]')).toBeNull();
    expect(editorRef.current?.getTextContent().trim()).toBe('');
  });

  it('renders composer skill chips with the shared inline alignment', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('[skill: test-skill] utilise ce skill');
      await Promise.resolve();
    });

    const skillChip = container.querySelector('[data-context-reference-kind="skill"]');
    expect(skillChip).toBeTruthy();
    expect(skillChip?.getAttribute('data-context-reference-surface')).toBe('composer');
    expect(skillChip?.className).toContain('h-[1.375rem]');
    expect(skillChip?.className).toContain('align-[0em]');
    expect(skillChip?.className).not.toContain('align-[-0.1875rem]');
  });

  it('does not remove composer context refs when deleting a message-edit chip', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Edit message"
          onTextChange={() => undefined}
          onSend={() => undefined}
          surface="message-edit"
          syncContextRefs={false}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('[skill: test-skill] utilise ce skill');
      await Promise.resolve();
    });

    const removeButton = container.querySelector('[data-context-reference-kind="skill"] button');
    expect(removeButton).toBeTruthy();

    await act(async () => {
      removeButton?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });

    expect(removeComposerContextRef).not.toHaveBeenCalled();
  });

  it('opens the slash context menu at the start of text or after a space', async () => {
    const skill = buildSkill('global:agents:test-skill:aaa', { name: 'test-skill' });
    skills = [skill];
    settingsBySkillId = {
      [skill.id]: { enabled: true, scriptsEnabled: false },
    };
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    expect(await openSlashMenu(editorRef, '/')).not.toBeNull();
    expect(refreshSkillsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      editorRef.current?.setText('hello /');
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-slash-context-menu="true"]')).not.toBeNull();
    expect(document.body.textContent).toContain('test-skill');
    expect(
      document.body.querySelector('[data-slash-context-option="command:/goal"]'),
    ).toBeNull();
  });

  it('keeps the Goal command in editor state without an inline control', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('/goal Finish the authentication migration');
      await Promise.resolve();
    });

    expect(container.querySelector('[data-goal-command-marker="true"]')).toBeNull();
    expect(editorRef.current?.getTextContent()).toBe(
      '/goal Finish the authentication migration',
    );
  });

  it('leaves lookalike and mid-sentence Goal commands as plain text', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('/goals list');
      await Promise.resolve();
    });
    await act(async () => {
      editorRef.current?.setText('Explain /goal behavior');
      await Promise.resolve();
    });
    expect(editorRef.current?.getTextContent()).toBe('Explain /goal behavior');
  });

  it('inserts the highlighted Goal command from the slash menu', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    expect(await openSlashMenu(editorRef, '/goa')).not.toBeNull();
    const goalOption = document.body.querySelector(
      '[data-slash-context-option="command:/goal"]',
    );
    expect(goalOption).not.toBeNull();
    expect(goalOption?.className).toContain('border-primary/35');
    expect(goalOption?.textContent).not.toContain('Goal mode');
    expect(goalOption?.querySelectorAll('svg')).toHaveLength(1);
    expect(goalOption?.querySelector('.rounded-full')).toBeNull();

    await act(async () => {
      goalOption?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-goal-command-marker="true"]')).toBeNull();
    expect(editorRef.current?.getTextContent()).toBe('/goal ');
  });

  it('does not open the slash context menu inside paths or urls', async () => {
    const skill = buildSkill('global:agents:test-skill:aaa', { name: 'test-skill' });
    skills = [skill];
    settingsBySkillId = {
      [skill.id]: { enabled: true, scriptsEnabled: false },
    };
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    expect(await openSlashMenu(editorRef, 'http://')).toBeNull();
    expect(await openSlashMenu(editorRef, 'foo/bar')).toBeNull();
  });

  it('inserts a literal tab in the composer when slash context is closed', async () => {
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    await act(async () => {
      editorRef.current?.setText('hello ');
      await Promise.resolve();
    });

    const editable = container.querySelector('[data-shortcut-chat-input="true"]');
    await act(async () => {
      editable?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });

    expect(editorRef.current?.getTextContent()).toBe('hello \t');
  });

  it('shows enabled skills in the slash context menu', async () => {
    const skill = buildSkill('global:agents:test-skill:aaa', { name: 'test-skill' });
    skills = [skill];
    settingsBySkillId = {
      [skill.id]: { enabled: true, scriptsEnabled: false },
    };
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    expect(await openSlashMenu(editorRef, '/')).not.toBeNull();
    expect(document.body.textContent).toContain('test-skill');
  });

  it('searches workspace files and inserts a file as a lazy context chip', async () => {
    const file = buildFile('src/App.tsx');
    fileSearchResults = [file];
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    expect(await openSlashMenu(editorRef, '/src')).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(searchWorkspaceFilesMock).toHaveBeenCalled();
    expect(document.body.textContent).toContain('App.tsx');
    expect(document.body.textContent).toContain('src/App.tsx');
    expect(document.body.textContent).toContain('Web/src/App.tsx');

    const option = document.body.querySelector('[data-slash-context-option="file:src/App.tsx"]');
    expect(option).toBeTruthy();
    expect(option?.getAttribute('title')).toBe('Web/src/App.tsx');

    await act(async () => {
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const fileChips = container.querySelectorAll('[data-context-reference-kind="file"]');
    expect(fileChips).toHaveLength(1);
    expect(editorRef.current?.getTextContent().trim()).toBe('[file: src/App.tsx]');
    expect(addComposerContextRef).toHaveBeenCalledWith({
      id: file.id,
      kind: 'file',
      title: 'src/App.tsx',
      subtitle: 'Web/src/App.tsx',
      data: file,
    });
  });

  it('does not list workspace files for an empty slash query', async () => {
    fileSearchResults = [buildFile('src/App.tsx')];
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    expect(await openSlashMenu(editorRef, '/')).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(searchWorkspaceFilesMock).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('src/App.tsx');
  });

  it('filters slash context and inserts an enabled skill as a single chip', async () => {
    const testSkill = buildSkill('global:agents:test-skill:aaa', { name: 'test-skill' });
    const otherSkill = buildSkill('global:agents:other-skill:bbb', { name: 'other-skill' });
    skills = [otherSkill, testSkill];
    settingsBySkillId = {
      [testSkill.id]: { enabled: true, scriptsEnabled: false },
      [otherSkill.id]: { enabled: true, scriptsEnabled: false },
    };
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    const menu = await openSlashMenu(editorRef, '/test');
    expect(menu).not.toBeNull();
    expect(document.body.textContent).toContain('test-skill');
    expect(document.body.textContent).not.toContain('other-skill');

    const option = document.body.querySelector('[data-slash-context-option="skill:test-skill"]');
    expect(option).toBeTruthy();

    await act(async () => {
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const skillChips = container.querySelectorAll('[data-context-reference-kind="skill"]');
    expect(skillChips).toHaveLength(1);
    expect(skillChips[0]?.textContent).toContain('test-skill');
    expect(editorRef.current?.getTextContent().trim()).toBe('[skill: test-skill]');
    expect(addComposerContextRef).toHaveBeenCalledWith({
      id: testSkill.id,
      kind: 'skill',
      title: 'test-skill',
      subtitle: 'Agents · Global',
      data: testSkill,
    });
  });

  it('navigates slash context with arrows and selects with Enter', async () => {
    const betaSkill = buildSkill('global:agents:beta:aaa', { name: 'beta' });
    const betterSkill = buildSkill('global:agents:better:bbb', { name: 'better' });
    skills = [betaSkill, betterSkill];
    settingsBySkillId = {
      [betaSkill.id]: { enabled: true, scriptsEnabled: false },
      [betterSkill.id]: { enabled: true, scriptsEnabled: false },
    };
    const onPromptHistory = mock(() => undefined);
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
          onPromptHistory={onPromptHistory}
        />
      );
    });

    expect(await openSlashMenu(editorRef, '/be')).not.toBeNull();
    const editable = container.querySelector('[data-shortcut-chat-input="true"]');

    await act(async () => {
      editable?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(
      document.body.querySelector('[data-slash-context-option="skill:better"]')?.getAttribute('aria-selected')
    ).toBe('true');
    expect(onPromptHistory).not.toHaveBeenCalled();

    await act(async () => {
      editable?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(editorRef.current?.getTextContent().trim()).toBe('[skill: better]');
  });

  it('selects the active slash context option with Tab', async () => {
    const alphaSkill = buildSkill('global:agents:alpha:aaa', { name: 'alpha' });
    skills = [alphaSkill];
    settingsBySkillId = {
      [alphaSkill.id]: { enabled: true, scriptsEnabled: false },
    };
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    expect(await openSlashMenu(editorRef, '/al')).not.toBeNull();
    const editable = container.querySelector('[data-shortcut-chat-input="true"]');

    await act(async () => {
      editable?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });

    expect(editorRef.current?.getTextContent().trim()).toBe('[skill: alpha]');
  });

  it('shows disabled slash context skills without selecting them and opens settings', async () => {
    const disabledSkill = buildSkill('global:agents:test-skill:aaa', { name: 'test-skill' });
    skills = [disabledSkill];
    settingsBySkillId = {
      [disabledSkill.id]: { enabled: false, scriptsEnabled: false },
    };
    const editorRef = React.createRef<ComposerEditorHandle>();

    await act(async () => {
      root.render(
        <ComposerEditor
          ref={editorRef}
          editable
          placeholder="Message"
          onTextChange={() => undefined}
          onSend={() => undefined}
        />
      );
    });

    expect(await openSlashMenu(editorRef, '/')).not.toBeNull();
    expect(document.body.textContent).not.toContain('test-skill');

    expect(await openSlashMenu(editorRef, '/test')).not.toBeNull();
    expect(document.body.textContent).toContain('Agents · Global');
    expect(document.body.textContent).not.toContain('Enable this skill in Settings before using it.');

    await act(async () => {
      document.body
        .querySelector('button[aria-label="Open Settings"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(addComposerContextRef).not.toHaveBeenCalled();
    expect(openSettingsMock).toHaveBeenCalledWith('skills');
  });
});
