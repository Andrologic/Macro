export type AppStateGetter<TState> = () => TState | Promise<TState>;

let appStateGetter: AppStateGetter<unknown> | null = null;

export const registerAppStateGetter = <TState>(
  getter: AppStateGetter<TState>,
): void => {
  appStateGetter = getter as AppStateGetter<unknown>;
};

export const getRegisteredAppState = async <TState>(): Promise<TState> => {
  if (!appStateGetter) {
    throw new Error('App state getter has not been registered.');
  }

  return await (appStateGetter() as TState | Promise<TState>);
};
