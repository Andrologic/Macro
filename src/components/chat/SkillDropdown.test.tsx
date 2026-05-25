import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillManifest, SkillSettings } from '../../types';

const loadSettingsMock = mock(async () => undefined);
const refreshSkillsMock = mock(async () => undefined);
const addComposerContextRefMock = mock((_ref: unknown) => undefined);
const openSettingsMock = mock((_tab?: string) => undefined);

let importCounter = 0;
let skills: SkillManifest[] = [];
let settingsBySkillId: Record<string, SkillSettings> = {};
let composerContextRefs: Array<{
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  data?: unknown;
}> = [];
let isLoading = false;

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
  resources: [],
  scripts: [],
  validationErrors: [],
  isValid: true,
  ...overrides,
});

const loadSkillDropdown = async () => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (
        key: string,
        fallbackOrOptions?: string | { count?: number; defaultValue?: string },
        maybeOptions?: { count?: number; defaultValue?: string },
      ) => {
        const template = typeof fallbackOrOptions === 'string'
          ? fallbackOrOptions
          : maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? key;
        const options = typeof fallbackOrOptions === 'string' ? maybeOptions : fallbackOrOptions;
        return template.replaceAll('{{count}}', String(options?.count ?? ''));
      },
    }),
  }));

  const skillsStoreState = {
    skills,
    settingsBySkillId,
    isLoading,
    loadSettings: loadSettingsMock,
    refreshSkills: refreshSkillsMock,
    getSkillById: (skillId: string) =>
      skills.find((skill) => skill.id === skillId) ?? null,
  };
  const useSkillsStore = ((selector?: (state: typeof skillsStoreState) => unknown) =>
    selector ? selector(skillsStoreState) : skillsStoreState) as unknown as {
    <T>(selector: (state: typeof skillsStoreState) => T): T;
    getState: () => typeof skillsStoreState;
  };
  useSkillsStore.getState = () => skillsStoreState;
  mock.module('../../stores/useSkillsStore', () => ({ useSkillsStore }));

  const chatStoreState = {
    composerContextRefs,
    addComposerContextRef: addComposerContextRefMock,
  };
  const useChatStore = ((selector?: (state: typeof chatStoreState) => unknown) =>
    selector ? selector(chatStoreState) : chatStoreState) as unknown as {
    <T>(selector: (state: typeof chatStoreState) => T): T;
    getState: () => typeof chatStoreState;
  };
  useChatStore.getState = () => chatStoreState;
  mock.module('../../stores/useChatStore', () => ({ useChatStore }));

  mock.module('../../stores/useAppStore', () => ({
    useAppStore: {
      getState: () => ({
        openSettings: openSettingsMock,
      }),
    },
  }));

  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../../utils/cn', () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }));

  importCounter += 1;
  return import(`./SkillDropdown.tsx?skill-dropdown-test=${importCounter}`);
};

describe('SkillDropdown', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    loadSettingsMock.mockClear();
    refreshSkillsMock.mockClear();
    addComposerContextRefMock.mockClear();
    openSettingsMock.mockClear();
    skills = [];
    settingsBySkillId = {};
    composerContextRefs = [];
    isLoading = false;
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

  it('refreshes on open and shows disabled discovered skills', async () => {
    const disabledSkill = buildSkill('global:test-skill', { name: 'test-skill' });
    skills = [disabledSkill];
    settingsBySkillId = {
      [disabledSkill.id]: { enabled: false, trusted: false, scriptsEnabled: false },
    };

    const { SkillDropdown } = await loadSkillDropdown();
    await act(async () => {
      root?.render(<SkillDropdown />);
      await Promise.resolve();
    });

    await act(async () => {
      container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(loadSettingsMock).toHaveBeenCalledTimes(1);
    expect(refreshSkillsMock).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain('No enabled skills. Enable one in Settings before using it.');
    expect(container?.textContent).toContain('test-skill');
    expect(container?.textContent).toContain('Enable this skill in Settings before using it.');
    expect(container?.textContent).toContain('Open Settings');
  });

  it('does not add a disabled skill and opens Skills settings instead', async () => {
    const disabledSkill = buildSkill('global:test-skill', { name: 'test-skill' });
    skills = [disabledSkill];
    settingsBySkillId = {
      [disabledSkill.id]: { enabled: false, trusted: false, scriptsEnabled: false },
    };

    const { SkillDropdown } = await loadSkillDropdown();
    await act(async () => {
      root?.render(<SkillDropdown />);
      await Promise.resolve();
    });
    await act(async () => {
      container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const disabledRow = Array.from(container?.querySelectorAll('div') ?? []).find((node) =>
      node.textContent?.includes('test-skill'),
    );
    await act(async () => {
      disabledRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const settingsButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Open Settings'),
    ) as HTMLButtonElement | undefined;
    expect(settingsButton).toBeTruthy();

    await act(async () => {
      settingsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(addComposerContextRefMock).not.toHaveBeenCalled();
    expect(openSettingsMock).toHaveBeenCalledWith('skills');
  });

  it('adds an enabled skill to the composer', async () => {
    const enabledSkill = buildSkill('project:project-1:docs', {
      name: 'docs',
      source: {
        kind: 'project',
        projectId: 'project-1',
        projectName: 'Web',
        rootPath: '/repo/web',
      },
    });
    skills = [enabledSkill];
    settingsBySkillId = {
      [enabledSkill.id]: { enabled: true, trusted: false, scriptsEnabled: false },
    };

    const { SkillDropdown } = await loadSkillDropdown();
    await act(async () => {
      root?.render(<SkillDropdown />);
      await Promise.resolve();
    });
    await act(async () => {
      container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const docsButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('docs'),
    ) as HTMLButtonElement | undefined;
    expect(docsButton).toBeTruthy();

    await act(async () => {
      docsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(addComposerContextRefMock).toHaveBeenCalledWith({
      id: enabledSkill.id,
      kind: 'skill',
      title: 'docs',
      subtitle: 'Agents · Web',
      data: enabledSkill,
    });
  });

  it('shows a discovered-empty state separately from loading', async () => {
    const { SkillDropdown } = await loadSkillDropdown();
    await act(async () => {
      root?.render(<SkillDropdown />);
      await Promise.resolve();
    });
    await act(async () => {
      container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('No skills discovered.');
    expect(container?.textContent).toContain('Open Settings');
  });
});
