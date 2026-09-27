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
