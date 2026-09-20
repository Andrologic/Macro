import { createLifecycleScope, type LifecycleScope } from './lifecycleScope';

export interface ApplicationStartupDependencies {
  install: (owner: LifecycleScope) => (() => void);
  restore: () => Promise<boolean>;
  initializeConfiguration: (owner: LifecycleScope) => Promise<void>;
  initializeLanguage: (owner: LifecycleScope) => Promise<void>;
  initializeSearch: (owner: LifecycleScope) => Promise<unknown>;
  installEffects: (owner: LifecycleScope) => () => void;
  render: (owner: LifecycleScope) => void;
  renderRecovery: (error: unknown) => void;
  reload: () => void;
  report: (error: unknown) => void;
}

/** One application generation. Retired generations cannot install or render. */
export function createApplicationStartup(dependencies: ApplicationStartupDependencies) {
  const owner = createLifecycleScope();
  let started: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;
  let disposePorts: (() => void) | undefined;
  const start = (previousRetirement: Promise<void> = Promise.resolve()): Promise<void> => {
    if (started) return started;
    started = owner.track((async () => {
      await previousRetirement;
      if (!owner.isActive()) return;
      try { disposePorts = dependencies.install(owner); }
      catch (error) { owner.stop(); throw error; }
      if (!owner.isActive()) return;
      let restored: boolean;
      try {
        restored = await dependencies.restore();
      } catch (error) {
        if (!owner.isActive()) return;
        try { await dependencies.initializeLanguage(owner); }
        catch (languageError) { if (owner.isActive()) dependencies.report(languageError); }
        if (owner.isActive()) dependencies.renderRecovery(error);
        return;
      }
      if (!owner.isActive()) return;
      if (restored) { dependencies.reload(); return; }
      try {
        await dependencies.initializeConfiguration(owner);
        if (!owner.isActive()) return;
        await Promise.all([
          owner.track(dependencies.initializeLanguage(owner)),
          owner.track(dependencies.initializeSearch(owner)),
        ]);
        if (!owner.isActive()) return;
        owner.own(dependencies.installEffects(owner));
      } catch (error) {
        if (owner.isActive()) dependencies.report(error);
      }
      if (owner.isActive()) dependencies.render(owner);
    })());
    return started;
  };
  const stop = (): Promise<void> => {
    if (stopped) return stopped;
    let failure: unknown;
    try { owner.stop(); } catch (error) { failure = error; }
    stopped = owner.drain().then(() => {
      // Admitted metadata writes may still use these ports until they settle.
      disposePorts?.();
      if (failure) throw failure;
    });
    return stopped;
  };
  return { owner, start, stop };
}
export type ApplicationStartup = ReturnType<typeof createApplicationStartup>;
