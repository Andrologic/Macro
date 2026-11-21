import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { commandRegistry } from '../../../shortcuts/runtime';
import { useShortcutsStore } from '../../../stores/useShortcutsStore';
import { installReactI18nextMock } from '../../../test-utils/reactI18nextMock';
import { SettingsSearchProvider } from '../search/SettingsSearch';

installReactI18nextMock();
const useAppStore = create(() => ({ mode: 'Chat' as const, settingsOpen: true }));
mock.module('../../../stores/useAppStore', () => ({ useAppStore }));
mock.module('../../../stores/useChatStore', () => ({
  useChatStore: (selector: (state: { selectedConversationId: null }) => unknown) =>
    selector({ selectedConversationId: null }),
}));
const { ShortcutsView } = await import('./ShortcutsView');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  mock.restore();
});

describe('ShortcutsView', () => {
  it('caches commands and keeps the recorder listener until its inputs change', async () => {
    const list = spyOn(commandRegistry, 'list');
    const addListener = spyOn(window, 'addEventListener');
    const removeListener = spyOn(window, 'removeEventListener');
    const recorderAdds = () => addListener.mock.calls.filter(([type, , capture]) => type === 'keydown' && capture === true).length;
    const recorderRemoves = () => removeListener.mock.calls.filter(([type, , capture]) => type === 'keydown' && capture === true).length;
    const render = () => act(async () => {
      root.render(<SettingsSearchProvider><ShortcutsView /></SettingsSearchProvider>);
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Record shortcut"]')!.click());
    const listCalls = list.mock.calls.length;
    const adds = recorderAdds();
    const removes = recorderRemoves();
    expect(adds).toBe(1);
    await render();
    expect(list.mock.calls.length).toBe(listCalls);
    expect(recorderAdds()).toBe(adds);
    expect(recorderRemoves()).toBe(removes);

    await act(async () => useAppStore.setState({ settingsOpen: false }));
    expect(list.mock.calls.length).toBeGreaterThan(listCalls);
    let dispose!: () => void;
    await act(async () => {
      dispose = commandRegistry.register({
        id: 'test.shortcut', owner: 'test.shortcuts-view', order: 100,
        definition: { label: 'Extra shortcut', description: 'Synthetic command', category: 'app', defaultBinding: null },
        constraints: {}, contextHints: [], handler: () => true,
      });
    });
    expect(container.textContent).toContain('Extra shortcut');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', altKey: true, bubbles: true }));
    });
    expect(useShortcutsStore.getState().bindings['app.openSettings']).toBe('Alt+J');
    await act(async () => dispose());
    expect(container.textContent).not.toContain('Extra shortcut');
  });
});
