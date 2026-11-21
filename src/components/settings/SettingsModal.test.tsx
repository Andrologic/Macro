import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import { installReactI18nextMock } from '../../test-utils/reactI18nextMock';
import { settingsRegistry, type SettingsContribution } from '../../composition/settings/registry';

installReactI18nextMock();
const useAppStore = create<{
  settingsOpen: boolean;
  activeSettingsTab: string;
  closeSettings: () => void;
  setSettingsTab: (id: string) => void;
}>((set) => ({
  settingsOpen: true,
  activeSettingsTab: 'test.a',
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (id) => set({ activeSettingsTab: id }),
}));
mock.module('../../stores/useAppStore', () => ({ useAppStore }));
mock.module('../../hooks/useAppVersion', () => ({ useAppVersion: () => 'test' }));
let storedPrompts = { promptArchitect: 'Saved Architect prompt', promptChat: 'Saved Chat prompt' };
const loadPrompts = mock(async () => ({ ...storedPrompts }));
const savePrompts = mock(async (values: typeof storedPrompts) => { storedPrompts = { ...values }; });
const preferences = await import('../../services/preferences');
mock.module('../../services/preferences', () => ({
  ...preferences,
  loadPersistedPreference: async (key: string) => (await loadPrompts())[key as keyof typeof storedPrompts],
  savePreferences: savePrompts,
}));
const { PromptsView } = await import('./views/PromptsView');
const { SettingsModal } = await import('./SettingsModal');
let root: Root;
let container: HTMLDivElement;
const builtinIds = settingsRegistry.all().map((entry) => entry.id);
const entry = (id: string, order = 0): SettingsContribution => ({
  id, order, owner: 'test.settings', icon: 'settings', labelKey: id, label: id,
  descriptionKey: `${id}.description`, description: `Description ${id}`,
  component: () => <div data-testid={id}>Content {id}</div>,
});

beforeEach(() => {
  storedPrompts = { promptArchitect: 'Saved Architect prompt', promptChat: 'Saved Chat prompt' };
  savePrompts.mockClear();
  savePrompts.mockImplementation(async (values) => { storedPrompts = { ...values }; });
  loadPrompts.mockImplementation(async () => ({ ...storedPrompts }));
  builtinIds.forEach((id) => settingsRegistry.setActive(id, false));
  useAppStore.setState({ settingsOpen: true, activeSettingsTab: 'test.a' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  settingsRegistry.removeOwner('test.settings');
  builtinIds.forEach((id) => settingsRegistry.setActive(id, true));
});
const render = () => act(async () => { root.render(<SettingsModal />); });
const button = (id: string) => [...document.body.querySelectorAll('nav button')].find((node) => node.textContent === id) as HTMLButtonElement;

describe('settings contributions', () => {
  it('renders and navigates synthetic entries in deterministic order without shell branches', async () => {
    settingsRegistry.register(entry('test.b'));
    settingsRegistry.register(entry('test.a'));
    await render();
    expect([...document.body.querySelectorAll('nav button')].map((node) => node.textContent)).toEqual(['test.a', 'test.b']);
    expect(document.body.querySelector('[data-testid="test.a"]')).not.toBeNull();
    await act(async () => button('test.b').click());
    expect(useAppStore.getState().activeSettingsTab).toBe('test.b');
    expect(document.body.querySelector('[data-testid="test.b"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Description test.b');
  });

  it('removes disabled and unavailable entries from navigation and content, then recovers', async () => {
    settingsRegistry.register(entry('test.a'));
    settingsRegistry.register({ ...entry('test.b'), available: ({ settingsOpen }) => !settingsOpen });
    await render();
    expect(button('test.b')).toBeUndefined();
    await act(async () => settingsRegistry.setActive('test.a', false));
    expect(document.body.querySelectorAll('nav button')).toHaveLength(0);
    expect(document.body.querySelector('[data-testid="test.a"]')).toBeNull();
    await act(async () => settingsRegistry.setActive('test.a', true));
    expect(document.body.querySelector('[data-testid="test.a"]')).not.toBeNull();
    await act(async () => settingsRegistry.removeOwner('test.settings'));
    expect(document.body.querySelectorAll('nav button')).toHaveLength(0);
    expect(document.body.querySelector('[data-testid="test.a"]')).toBeNull();
  });

  it('keeps navigation available after a rejected import and retries the loader', async () => {
    let attempts = 0;
    const metadata = entry('test.a');
    settingsRegistry.register({ ...metadata, component: undefined, load: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Synthetic import failure');
      return { default: () => <div data-testid="recovered">Recovered settings</div> };
    } });
    settingsRegistry.register(entry('test.b'));
    await render();
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(button('test.b')).toBeDefined();
    const retry = [...document.body.querySelectorAll('button')].find((node) => node.textContent === 'Retry');
    await act(async () => retry?.click());
    expect(attempts).toBe(2);
    expect(document.body.querySelector('[data-testid="recovered"]')).not.toBeNull();
    await act(async () => button('test.b').click());
    expect(document.body.querySelector('[data-testid="test.b"]')).not.toBeNull();
  });

  it('rejects collisions and ignores a stale disposer after owner replacement', async () => {
    const dispose = settingsRegistry.register(entry('test.a'));
    expect(() => settingsRegistry.register(entry('test.a'))).toThrow('Duplicate contribution');
    settingsRegistry.removeOwner('test.settings');
    settingsRegistry.register(entry('test.a'));
    dispose();
    await render();
    expect(document.body.querySelector('[data-testid="test.a"]')).not.toBeNull();
  });
});

describe('prompt drafts in the settings window', () => {
  const field = () => document.body.querySelector<HTMLTextAreaElement>('#promptArchitect')!;
  const saveButton = () => [...document.body.querySelectorAll('button')].find((node) => node.textContent?.includes('Save Changes') || node.textContent === 'Saved')!;
  const openPrompts = async () => {
    settingsRegistry.register({ ...entry('test.a'), load: undefined, component: PromptsView });
    settingsRegistry.register(entry('test.b'));
    await render();
  };
  const edit = async (value = 'Unsaved draft été') => {
    await act(async () => {
      const input = field();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('keeps typed drafts and the save action across internal navigation without saving', async () => {
    await openPrompts();
    await edit();
    expect(saveButton().disabled).toBe(false);
    await act(async () => button('test.b').click());
    expect(document.body.querySelector('textarea')).toBeNull();
    await act(async () => button('test.a').click());
    expect(field().value).toBe('Unsaved draft été');
    expect(saveButton().disabled).toBe(false);
    expect(savePrompts).not.toHaveBeenCalled();
    await act(async () => saveButton().click());
    expect(storedPrompts.promptArchitect).toBe('Unsaved draft été');
    expect([...document.body.querySelectorAll('button')].find((node) => node.textContent === 'Saved')?.disabled).toBe(true);
    await act(async () => button('test.b').click());
    await act(async () => button('test.a').click());
    expect(field().value).toBe('Unsaved draft été');
    expect(saveButton().disabled).toBe(true);
  });

  it('keeps edits made before preferences finish loading and hydrates untouched prompts', async () => {
    let resolveLoad!: (value: typeof storedPrompts) => void;
    const loading = new Promise<typeof storedPrompts>((resolve) => { resolveLoad = resolve; });
    loadPrompts.mockImplementation(() => loading);
    await openPrompts();
    await edit();
    await act(async () => button('test.b').click());
    await act(async () => resolveLoad({ ...storedPrompts }));
    await act(async () => button('test.a').click());
    expect(field().value).toBe('Unsaved draft été');
    expect(document.body.querySelector<HTMLTextAreaElement>('#promptChat')?.value).toBe('Saved Chat prompt');
    expect(saveButton().disabled).toBe(false);
  });

  it('blocks save until hydration and preserves untouched persisted prompts', async () => {
    let finish!: (value: typeof storedPrompts) => void;
    const initial = { ...storedPrompts };
    const loading = new Promise<typeof storedPrompts>((resolve) => { finish = resolve; });
    loadPrompts.mockImplementation(() => loading);
    await openPrompts();
    await edit();
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(savePrompts).not.toHaveBeenCalled();
    await act(async () => finish(initial));
    await act(async () => saveButton().click());
    expect(storedPrompts.promptArchitect).toBe('Unsaved draft été');
    expect(storedPrompts.promptChat).toBe(initial.promptChat);
  });

  it('blocks save after a failed read and retries without discarding a typed draft', async () => {
    loadPrompts.mockImplementation(async () => { throw new Error('Read failed'); });
    await openPrompts();
    await edit();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Unable to load system prompts');
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(savePrompts).not.toHaveBeenCalled();
    loadPrompts.mockImplementation(async () => ({ ...storedPrompts }));
    await act(async () => [...document.body.querySelectorAll('button')].find((node) => node.textContent === 'Retry')!.click());
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(field().value).toBe('Unsaved draft été');
    await act(async () => saveButton().click());
    expect(storedPrompts.promptChat).toBe('Saved Chat prompt');
  });

  it('keeps one save pending across navigation and preserves edits made during that save', async () => {
    let finish!: () => void;
    savePrompts.mockImplementationOnce((values) => new Promise<void>((resolve) => {
      finish = () => { storedPrompts = { ...values }; resolve(); };
    }));
    await openPrompts();
    await edit('Draft A');
    await act(async () => saveButton().click());
    await act(async () => button('test.b').click());
    await act(async () => button('test.a').click());
    expect(saveButton().disabled).toBe(true);
    await edit('Draft B');
    await act(async () => saveButton().click());
    expect(savePrompts).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(storedPrompts.promptArchitect).toBe('Draft A');
    expect(field().value).toBe('Draft B');
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(storedPrompts.promptArchitect).toBe('Draft B');
  });

  it('waits for a save from the closed window before hydrating the reopened window', async () => {
    let finish!: () => void;
    savePrompts.mockImplementationOnce((values) => new Promise<void>((resolve) => {
      finish = () => { storedPrompts = { ...values }; resolve(); };
    }));
    await openPrompts();
    await edit('Saving draft');
    await act(async () => saveButton().click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    await act(async () => useAppStore.setState({ settingsOpen: true }));
    expect(saveButton().disabled).toBe(true);
    await act(async () => finish());
    expect(field().value).toBe('Saving draft');
    expect(saveButton().disabled).toBe(true);
  });

  it('retains the dirty draft after a rejected save and allows retry', async () => {
    savePrompts.mockImplementationOnce(async () => { throw new Error('Write failed'); });
    await openPrompts();
    await edit();
    await act(async () => saveButton().click());
    await act(async () => button('test.b').click());
    await act(async () => button('test.a').click());
    expect(field().value).toBe('Unsaved draft été');
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(storedPrompts.promptArchitect).toBe('Unsaved draft été');
  });

  for (const closeWith of ['button', 'escape'] as const) {
    it(`discards unsaved drafts on close by ${closeWith} and reloads saved values on reopening`, async () => {
      await openPrompts();
      await edit();
      await act(async () => {
        if (closeWith === 'button') document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(useAppStore.getState().settingsOpen).toBe(false);
      await act(async () => useAppStore.setState({ settingsOpen: true }));
      expect(field().value).toBe('Saved Architect prompt');
      expect(saveButton().disabled).toBe(true);
      expect(savePrompts).not.toHaveBeenCalled();
    });
  }
});
