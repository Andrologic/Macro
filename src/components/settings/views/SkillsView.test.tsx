import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillManifest, SkillSettings } from '../../../types';

const loadSettingsMock = mock(async () => undefined);
const refreshSkillsMock = mock(async () => undefined);
const installSkillFromLocalPathMock = mock(async (_path: string) => undefined);
let createdSkillTemplate: SkillManifest | null = null;
const createSkillTemplateMock = mock(async (_data: unknown) => createdSkillTemplate);
const openSkillLocationMock = mock(async (_skillId: string, _target: 'skillFile' | 'folder') => true);
const setSkillEnabledMock = mock((_skillId: string, _enabled: boolean) => undefined);
const setSkillScriptsEnabledMock = mock((_skillId: string, _enabled: boolean) => undefined);
const openDialogMock = mock(async () => '/tmp/imported-skill');
const notifySuccessMock = mock((_message: string) => undefined);
const notifyErrorMock = mock((_message: string, _options?: unknown) => undefined);

let importCounter = 0;
let skills: SkillManifest[] = [];
let settingsBySkillId: Record<string, SkillSettings> = {};
let lastError: string | null = null;
let nativeToolsSupported = true;
let runtimeSkillsSupported = true;
let runtimeSkillCreationSupported = true;
let toolRiskLevel: 'strict' | 'balanced' | 'yolo' = 'balanced';

const defaultSettings: SkillSettings = {
  enabled: false,
  scriptsEnabled: false,
};

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
        projectId: 'project-1',
        projectName: 'Web',
        rootPath: '/repo/web',
      }
    : {
        kind: 'global',
        projectId: null,
        projectName: null,
        rootPath: '/Users/test/.agents/skills',
      },
  resources: [{ path: 'references/style.md', kind: 'reference', sizeBytes: 12 }],
  scripts: [{ path: 'scripts/check.sh', kind: 'script', sizeBytes: 20 }],
  validationErrors: [],
  isValid: true,
  ...overrides,
});

const loadSkillsView = async () => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (
        key: string,
        fallbackOrOptions?: string | { defaultValue?: string; count?: number },
        maybeOptions?: { defaultValue?: string; count?: number },
      ) => {
        const template = typeof fallbackOrOptions === 'string'
          ? fallbackOrOptions
          : maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? key;
        const options = typeof fallbackOrOptions === 'string' ? maybeOptions : fallbackOrOptions;
        return template.replaceAll('{{count}}', String(options?.count ?? ''));
      },
    }),
  }));

  const storeState = {
    skills,
    isLoading: false,
    saving: false,
    lastError,
    loadSettings: loadSettingsMock,
    refreshSkills: refreshSkillsMock,
    installSkillFromLocalPath: installSkillFromLocalPathMock,
    createSkillTemplate: createSkillTemplateMock,
    openSkillLocation: openSkillLocationMock,
    getSkillSettings: (skillId: string) => settingsBySkillId[skillId] ?? defaultSettings,
    setSkillEnabled: setSkillEnabledMock,
    setSkillScriptsEnabled: setSkillScriptsEnabledMock,
  };
  const useSkillsStore = (() => storeState) as unknown as {
    (): typeof storeState;
    getState: () => typeof storeState;
  };
  useSkillsStore.getState = () => storeState;

  mock.module('../../../stores/useSkillsStore', () => ({ useSkillsStore }));

  const providerStoreState = {
    selectedSupportsNativeToolCalling: () => nativeToolsSupported,
  };
  const useProviderStore = ((selector?: (state: typeof providerStoreState) => unknown) =>
    selector ? selector(providerStoreState) : providerStoreState) as unknown as {
    <T>(selector: (state: typeof providerStoreState) => T): T;
  };
  mock.module('../../../stores/useProviderStore', () => ({ useProviderStore }));

  const appState = {
    projectGroups: [
      {
        id: 'group-1',
        name: 'Workspace',
        isOpen: true,
        projects: [
          {
            id: 'project-1',
            name: 'Web',
            path: '/repo/web',
          },
        ],
      },
    ],
  };
  const useAppStore = ((selector?: (state: typeof appState) => unknown) =>
    selector ? selector(appState) : appState) as unknown as {
    <T>(selector: (state: typeof appState) => T): T;
  };
  mock.module('../../../stores/useAppStore', () => ({ useAppStore }));

  const skillsConfig = {
    installDestinations: {
      'global-default': { scope: 'user', path: '${home}/.agents/skills' },
      'project-default': { scope: 'project', path: '.agents/skills' },
    },
    defaultGlobalDestination: 'global-default',
    defaultProjectDestination: 'project-default',
  };
  const configStoreState = {
    snapshot: {
      effective: { skills: skillsConfig },
      projectEffective: { 'project-1': { skills: skillsConfig } },
    },
    getDocument: mock(async () => ({ etag: 'skills-etag' })),
    patch: mock(async () => ({})),
  };
  const useConfigStore = ((selector: (state: typeof configStoreState) => unknown) =>
    selector(configStoreState)) as unknown as {
    <T>(selector: (state: typeof configStoreState) => T): T;
  };
  const configStoreModule = await import(
    `../../../stores/useConfigStore.ts?skills-view-config-store-test=${importCounter}`
  );
  mock.module('../../../stores/useConfigStore', () => ({
    ...configStoreModule,
    useConfigStore,
  }));

  mock.module('../../../services', () => ({
    getServiceRuntimeCapabilities: () => ({
      skills: runtimeSkillsSupported,
      skillCreation: runtimeSkillCreationSupported,
    }),
  }));

  mock.module('../../../services/preferences', () => ({
    PREF_KEYS: { TOOL_RISK_LEVEL: 'toolRiskLevel' },
    loadPreference: mock(async () => toolRiskLevel),
  }));

  mock.module('@tauri-apps/plugin-dialog', () => ({
    open: openDialogMock,
  }));

  mock.module('../../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../../ui/Input', () => ({
    Input: ({
      onChange,
      ...props
    }: React.InputHTMLAttributes<HTMLInputElement>) => (
      <input
        {...props}
        onChange={onChange}
        onInput={(event) => onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>)}
      />
    ),
  }));

  mock.module('../../ui/Textarea', () => ({
    Textarea: ({
      onChange,
      ...props
    }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
      <textarea
        {...props}
        onChange={onChange}
        onInput={(event) => onChange?.(event as unknown as React.ChangeEvent<HTMLTextAreaElement>)}
      />
    ),
  }));

  mock.module('../../ui/Switch', () => ({
    Switch: ({
      checked,
      disabled,
      onCheckedChange,
      'aria-label': ariaLabel,
    }: {
      checked: boolean;
      disabled?: boolean;
      onCheckedChange: (value: boolean) => void;
      'aria-label'?: string;
    }) => (
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  }));

  mock.module('../../ui/toastService', () => ({
    notify: {
      success: notifySuccessMock,
      error: notifyErrorMock,
      warning: mock(() => undefined),
      info: mock(() => undefined),
      actionRequired: mock(() => undefined),
      dismiss: mock(() => undefined),
    },
  }));

  mock.module('../../../utils/cn', () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }));

  importCounter += 1;
  return import(`./SkillsView.tsx?skills-view-test=${importCounter}`);
};

describe('SkillsView', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    loadSettingsMock.mockClear();
    refreshSkillsMock.mockClear();
    installSkillFromLocalPathMock.mockClear();
    createSkillTemplateMock.mockClear();
    openSkillLocationMock.mockClear();
    setSkillEnabledMock.mockClear();
    setSkillScriptsEnabledMock.mockClear();
    openDialogMock.mockClear();
    notifySuccessMock.mockClear();
    notifyErrorMock.mockClear();
    skills = [];
    settingsBySkillId = {};
    createdSkillTemplate = null;
    lastError = null;
    nativeToolsSupported = true;
    runtimeSkillsSupported = true;
    runtimeSkillCreationSupported = true;
    toolRiskLevel = 'balanced';
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
    root = null;
    container = null;
    mock.restore();
  });

  it('renders compact skill cards and reveals details from the settings button', async () => {
    skills = [
      buildSkill('project:project-1:docs', {
        name: 'docs',
        description: 'Project documentation rules',
        resources: [
          { path: 'references/style.md', kind: 'reference', sizeBytes: 12 },
          { path: 'assets/template.md', kind: 'asset', sizeBytes: 24 },
        ],
      }),
      buildSkill('global:broken', {
        name: 'broken',
        description: '',
        isValid: false,
        validationErrors: ['Missing required name.'],
        scripts: [],
      }),
    ];

    const { SkillsView } = await loadSkillsView();
    await act(async () => {
      root?.render(<SkillsView />);
      await Promise.resolve();
    });

    expect(loadSettingsMock).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain('Project documentation rules');
    expect(container?.textContent).toContain('Web');
    expect(container?.textContent).toContain('Global');
    expect(container?.textContent).toContain('Invalid');
    expect(container?.textContent).not.toContain('2 resources');
    expect(container?.textContent).not.toContain('Missing required name.');

    const detailButtons = Array.from(
      container?.querySelectorAll('button[title="Details"]') ?? []
    );
    expect(detailButtons).toHaveLength(2);

    await act(async () => {
      detailButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('2 resources');
    expect(container?.textContent).toContain('1 scripts');
    expect(container?.textContent).toContain('/skills/project-project-1-docs/SKILL.md');

    await act(async () => {
      detailButtons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Missing required name.');
  });

  it('shows why skills are unavailable', async () => {
    nativeToolsSupported = false;
    toolRiskLevel = 'strict';
    const disabledSkill = buildSkill('global:test-skill', { name: 'test-skill' });
    const enabledRunner = buildSkill('project:project-1:runner', { name: 'runner' });
    skills = [
      disabledSkill,
      enabledRunner,
      buildSkill('global:broken', {
        name: 'broken',
        isValid: false,
        validationErrors: ['Missing required description.'],
      }),
    ];
    settingsBySkillId = {
      [enabledRunner.id]: { enabled: true, scriptsEnabled: true },
    };

    const { SkillsView } = await loadSkillsView();
    await act(async () => {
      root?.render(<SkillsView />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain(
      'The selected provider or model does not support native tool calling.'
    );
    expect(container?.textContent).toContain('Unavailable');
    expect(container?.textContent).not.toContain('Disabled.');

    const detailButtons = Array.from(
      container?.querySelectorAll('button[title="Details"]') ?? []
    );

    await act(async () => {
      detailButtons.forEach((button) =>
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      );
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Disabled.');
    expect(container?.textContent).toContain('Invalid skill.');
    expect(container?.textContent).toContain('Strict risk mode blocks skill scripts.');
  });

  it('shows remote mode as unsupported for skills', async () => {
    runtimeSkillsSupported = false;

    const { SkillsView } = await loadSkillsView();
    await act(async () => {
      root?.render(<SkillsView />);
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Skills are not supported in remote mode yet.');
  });

  it('filters skills by search query', async () => {
    skills = [
      buildSkill('project:project-1:docs', { name: 'docs' }),
      buildSkill('global:lint', { name: 'lint', description: 'Linting conventions' }),
    ];
    const { SkillsView } = await loadSkillsView();
    await act(async () => {
      root?.render(<SkillsView />);
      await Promise.resolve();
    });

    const searchInput = container?.querySelector(
      'input[placeholder="Search skills..."]',
    ) as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        searchInput,
        'lint',
      );
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Linting conventions');
    expect(container?.textContent).not.toContain('docs');
  });

  it('updates toggles and imports a local skill folder', async () => {
    const skill = buildSkill('project:project-1:runner', { name: 'runner' });
    skills = [skill];
    settingsBySkillId = {
      [skill.id]: { enabled: false, scriptsEnabled: false },
    };
    const { SkillsView } = await loadSkillsView();
    await act(async () => {
      root?.render(<SkillsView />);
      await Promise.resolve();
    });

    const globalSwitch = container?.querySelector(
      'input[type="checkbox"][aria-label="Enable"]',
    ) as HTMLInputElement | null;
    expect(globalSwitch).toBeTruthy();

    await act(async () => {
      globalSwitch!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(setSkillEnabledMock).toHaveBeenCalledWith(skill.id, true);
    expect(setSkillScriptsEnabledMock).not.toHaveBeenCalled();

    const detailButton = container?.querySelector('button[title="Details"]');
    expect(detailButton).toBeTruthy();
    await act(async () => {
      detailButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const scriptsSwitch = container?.querySelector(
      'input[type="checkbox"][aria-label="Scripts"]',
    ) as HTMLInputElement | null;
    expect(scriptsSwitch).toBeTruthy();

    await act(async () => {
      scriptsSwitch!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(setSkillScriptsEnabledMock).toHaveBeenCalledWith(skill.id, true);

    const importButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Import')
    );
    expect(importButton).toBeTruthy();
    await act(async () => {
      importButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openDialogMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Select a skill folder',
    });
    expect(installSkillFromLocalPathMock).toHaveBeenCalledWith('/tmp/imported-skill');
    expect(notifySuccessMock).toHaveBeenCalledWith('Skill imported');
  });

  it('offers details actions and creates a local skill template', async () => {
    const skill = buildSkill('global:agents:docs:aaa111', { name: 'docs' });
    skills = [skill];
    createdSkillTemplate = buildSkill('global:agents:new-skill:bbb222', {
      name: 'new-skill',
      rootPath: '/Users/test/.agents/skills/new-skill',
    });
    const writeTextMock = mock(async (_value: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });

    const { SkillsView } = await loadSkillsView();
    await act(async () => {
      root?.render(<SkillsView />);
      await Promise.resolve();
    });

    const detailButton = container?.querySelector('button[title="Details"]');
    await act(async () => {
      detailButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const buttons = Array.from(container?.querySelectorAll('button') ?? []);
    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Open folder'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(openSkillLocationMock).toHaveBeenCalledWith(skill.id, 'folder');

    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Copy path'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalledWith(skill.skillFilePath);

    await act(async () => {
      buttons.find((button) =>
        button.textContent === 'Refresh'
      )?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(refreshSkillsMock).toHaveBeenCalled();

    await act(async () => {
      buttons.find((button) => button.textContent?.includes('New skill'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container?.textContent).toContain('Create skill');

    const nameInput = Array.from(container?.querySelectorAll('input') ?? []).find(
      (input) => (input as HTMLInputElement).value === 'new-skill',
    ) as HTMLInputElement | undefined;
    const descriptionInput = container?.querySelector('textarea') as HTMLTextAreaElement | null;
    const locationSelect = container?.querySelector(
      'select[aria-label="Location"]',
    ) as HTMLSelectElement | null;
    expect(nameInput).toBeTruthy();
    expect(descriptionInput).toBeTruthy();
    expect(locationSelect).toBeTruthy();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        nameInput,
        'project-helper',
      );
      nameInput!.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        descriptionInput,
        'Use when project work needs focused guidance.',
      );
      descriptionInput!.dispatchEvent(new Event('input', { bubbles: true }));
      locationSelect!.value = 'project:project-1';
      locationSelect!.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const dialogButtons = Array.from(container?.querySelectorAll('button') ?? []);
    await act(async () => {
      dialogButtons.find((button) => button.textContent?.includes('Create'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createSkillTemplateMock).toHaveBeenCalledWith({
      name: 'project-helper',
      description: 'Use when project work needs focused guidance.',
      destinationKind: 'project',
      destinationId: 'project-default',
      projectId: 'project-1',
    });
    expect(openSkillLocationMock).toHaveBeenCalledWith(createdSkillTemplate!.id, 'skillFile');
  });

  it('keeps script permission independent from the global skill switch', async () => {
    const skill = buildSkill('project:project-1:runner', { name: 'runner' });
    skills = [skill];
    settingsBySkillId = {
      [skill.id]: { enabled: true, scriptsEnabled: true },
    };
    const { SkillsView } = await loadSkillsView();
    await act(async () => {
      root?.render(<SkillsView />);
      await Promise.resolve();
    });

    const detailButton = container?.querySelector('button[title="Details"]');
    await act(async () => {
      detailButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const globalSwitch = container?.querySelector(
      'input[type="checkbox"][aria-label="Enable"]'
    ) as HTMLInputElement | null;
    expect(globalSwitch).toBeTruthy();

    await act(async () => {
      globalSwitch!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(setSkillEnabledMock).toHaveBeenCalledWith(skill.id, false);
    expect(setSkillScriptsEnabledMock).not.toHaveBeenCalled();

    settingsBySkillId = {
      [skill.id]: { enabled: false, scriptsEnabled: true },
    };
    await act(async () => {
      root?.render(<SkillsView />);
      await Promise.resolve();
    });

    const globalSwitchWhileDisabled = container?.querySelector(
      'input[type="checkbox"][aria-label="Enable"]',
    ) as HTMLInputElement | null;
    const scriptsSwitchWhileDisabled = container?.querySelector(
      'input[type="checkbox"][aria-label="Scripts"]',
    ) as HTMLInputElement | null;
    expect(globalSwitchWhileDisabled).toBeTruthy();
    expect(scriptsSwitchWhileDisabled?.checked).toBe(true);

    await act(async () => {
      scriptsSwitchWhileDisabled?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(setSkillScriptsEnabledMock).toHaveBeenCalledWith(skill.id, false);

    await act(async () => {
      globalSwitchWhileDisabled?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(setSkillEnabledMock).toHaveBeenCalledWith(skill.id, true);
  });
});
