import { describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStoreHookMock } from './storeHookMock';

type TestState = {
  count: number;
  label: string;
};

describe('createStoreHookMock', () => {
  it('merges, replaces, and derives state like a Zustand store', () => {
    let state: TestState = { count: 1, label: 'initial' };
    const store = createStoreHookMock(
      () => state,
      (nextState) => {
        state = nextState;
      },
    );
    const listener = mock(() => undefined);
    store.subscribe(listener);

    store.setState({ count: 2 });
    expect(store.getState()).toEqual({ count: 2, label: 'initial' });

    store.setState((current) => ({ count: current.count + 3 }));
    expect(store.getState()).toEqual({ count: 5, label: 'initial' });

    store.setState({ count: 9, label: 'replacement' }, true);
    expect(store.getState()).toEqual({ count: 9, label: 'replacement' });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('stops notifying an unsubscribed listener', () => {
    let state: TestState = { count: 1, label: 'initial' };
    const store = createStoreHookMock(
      () => state,
      (nextState) => {
        state = nextState;
      },
    );
    const listener = mock(() => undefined);
    const unsubscribe = store.subscribe(listener);

    store.emit();
    unsubscribe();
    store.emit();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rerenders a component with the selected value after setState', async () => {
    let state: TestState = { count: 1, label: 'initial' };
    const store = createStoreHookMock(
      () => state,
      (nextState) => {
        state = nextState;
      },
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const Counter = () => <span>{store((current) => current.count)}</span>;

    await act(async () => {
      root.render(<Counter />);
    });
    expect(container.textContent).toBe('1');

    await act(async () => {
      store.setState({ count: 7 });
    });
    expect(container.textContent).toBe('7');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
