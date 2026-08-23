import { useSyncExternalStore } from 'react';

type StoreStateUpdate<T extends object> =
  | Partial<T>
  | T
  | ((state: T) => Partial<T> | T);

export type StoreHookMock<T extends object> = {
  (): T;
  <Selection>(selector: (state: T) => Selection): Selection;
  emit: () => void;
  getState: () => T;
  setState: (update: StoreStateUpdate<T>, replace?: boolean) => void;
  subscribe: (listener: () => void) => () => void;
};

export const createStoreHookMock = <T extends object>(
  getSnapshot: () => T,
  setSnapshot: (nextState: T) => void,
): StoreHookMock<T> => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const hook = (<Selection>(selector?: (state: T) => Selection) => {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return selector ? selector(snapshot) : snapshot;
  }) as StoreHookMock<T>;

  hook.emit = () => {
    listeners.forEach((listener) => listener());
  };
  hook.getState = getSnapshot;
  hook.setState = (update, replace = false) => {
    const currentState = getSnapshot();
    const nextState = typeof update === 'function' ? update(currentState) : update;
    setSnapshot((replace ? nextState : { ...currentState, ...nextState }) as T);
    hook.emit();
  };
  hook.subscribe = subscribe;

  return hook;
};
