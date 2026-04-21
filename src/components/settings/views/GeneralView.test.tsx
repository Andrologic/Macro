import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const loadPreferenceMock = mock(async (_key?: string) => 'balanced');
const savePreferenceMock = mock(async (_key?: string, _value?: unknown) => undefined);
const loadProjectOpenSettingsMock = mock(async () => ({
  appsByAction: {
    editor: [{ id: 'none', label: 'Do nothing', kind: 'none' }],
    terminal: [{ id: 'none', label: 'Do nothing', kind: 'none' }],
    files: [{ id: 'none', label: 'Do nothing', kind: 'none' }],
  },
  selectedAppIdsByAction: {
    editor: 'none',
    terminal: 'none',
    files: 'none',
  },
}));
const saveProjectOpenAppPreferenceMock = mock(
  async (_action?: string, _value?: string) => undefined
);
const setProjectSwitchPolicyMock = mock(
  async (_policy?: 'resume_per_project' | 'reset_on_switch') => undefined
);
const setMetadataAutoPushMock = mock((_value?: boolean) => undefined);

let importCounter = 0;
let appState = {
  projectSwitchPolicy: 'resume_per_project' as const,
  setProjectSwitchPolicy: setProjectSwitchPolicyMock,
  metadataAutoPush: true,
  setMetadataAutoPush: setMetadataAutoPushMock,
};

const loadGeneralView = async () => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (
        _key: string,
        fallbackOrOptions?: string | { defaultValue?: string },
        maybeOptions?: { defaultValue?: string }
      ) => {
        if (typeof fallbackOrOptions === 'string') {
          return fallbackOrOptions;
        }

        return maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? _key;
      },
      i18n: {
        resolvedLanguage: 'en',
        language: 'en',
      },
    }),
  }));

  mock.module('../../../i18n', () => ({
    changeLanguage: async (_language: string) => undefined,
    resolveSupportedLanguage: (language: string) => language || 'en',
  }));

  mock.module('../../../i18n/languages', () => ({
    SUPPORTED_LANGUAGE_METADATA: [{ code: 'en', nativeName: 'English' }],
  }));

  mock.module('../../../stores/useAppStore', () => ({
    useAppStore: (selector?: (state: typeof appState) => unknown) =>
      selector ? selector(appState) : appState,
  }));

  mock.module('../../../services/projectOpeners', () => ({
    getEmptyProjectOpenSelection: () => ({
      editor: 'none',
      terminal: 'none',
      files: 'none',
    }),
    loadProjectOpenSettings: () => loadProjectOpenSettingsMock(),
    saveProjectOpenAppPreference: (action: string, value: string) =>
      saveProjectOpenAppPreferenceMock(action, value),
  }));

  const actualPreferences = await import(
    `../../../services/preferences.ts?general-view-test=${importCounter + 1}`
  );

  mock.module('../../../services/preferences', () => ({
    ...actualPreferences,
    loadPreference: (key: string) => loadPreferenceMock(key),
    savePreference: (key: string, value: unknown) => savePreferenceMock(key, value),
  }));

  mock.module('../../ui/Select', () => ({
    Select: ({
      children,
      value,
      onChange,
      disabled,
    }: React.SelectHTMLAttributes<HTMLSelectElement>) => (
      <select value={value} onChange={onChange} disabled={disabled}>
        {children}
      </select>
    ),
  }));

  mock.module('../../ui/Switch', () => ({
    Switch: ({
      checked,
      onCheckedChange,
      disabled,
      id,
    }: {
      checked: boolean;
      onCheckedChange: (value: boolean) => void;
      disabled?: boolean;
      id?: string;
    }) => (
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  }));

  mock.module('../../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../../ui/ConfirmPromptModal', () => ({
    ConfirmPromptModal: ({
      isOpen,
      title,
      description,
      confirmLabel,
      cancelLabel,
      onCancel,
      onConfirm,
    }: {
      isOpen: boolean;
      title: string;
      description: string;
      confirmLabel: string;
      cancelLabel: string;
      onCancel: () => void;
      onConfirm: () => void;
    }) =>
      isOpen ? (
        <div data-testid="confirm-modal">
          <div>{title}</div>
          <div>{description}</div>
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      ) : null,
  }));

  mock.module('../../../utils/cn', () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }));

  importCounter += 1;
  return import(`./GeneralView.tsx?test=${importCounter}`);
};

describe('GeneralView', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    loadPreferenceMock.mockClear();
    savePreferenceMock.mockClear();
    loadProjectOpenSettingsMock.mockClear();
    saveProjectOpenAppPreferenceMock.mockClear();
    setProjectSwitchPolicyMock.mockClear();
    setMetadataAutoPushMock.mockClear();
    appState = {
      projectSwitchPolicy: 'resume_per_project',
      setProjectSwitchPolicy: setProjectSwitchPolicyMock,
      metadataAutoPush: true,
      setMetadataAutoPush: setMetadataAutoPushMock,
    };

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

  it('renders the approval selector in the general application section', async () => {
    loadPreferenceMock.mockImplementation(async () => 'strict');
    const { GeneralView } = await loadGeneralView();

    await act(async () => {
      root?.render(<GeneralView />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Security & approvals');
    expect(container?.textContent).toContain('Strict');
    expect(container?.textContent).toContain('Project context memory');
    expect(container?.textContent).not.toContain('Architect Tool Autonomy');
    expect(container?.querySelector('[data-icon="lock"]')).not.toBeNull();
    expect(container?.querySelector('[data-icon="shield"]')).not.toBeNull();
    expect(container?.querySelector('[data-icon="zap"]')).not.toBeNull();
  });

  it('requires an explicit confirmation before enabling YOLO mode from general settings', async () => {
    loadPreferenceMock.mockImplementation(async () => 'balanced');
    const { GeneralView } = await loadGeneralView();

    await act(async () => {
      root?.render(<GeneralView />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const yoloButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.includes('YOLO')
    );

    await act(async () => {
      yoloButton?.click();
    });

    expect(container?.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();
    expect(savePreferenceMock).not.toHaveBeenCalled();

    const confirmButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.includes('Enable YOLO')
    );

    await act(async () => {
      confirmButton?.click();
      await Promise.resolve();
    });

    expect(savePreferenceMock).toHaveBeenCalledWith('toolRiskLevel', 'yolo');
  });
});
