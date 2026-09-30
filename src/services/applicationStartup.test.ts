import { expect, mock, test } from 'bun:test';
import { createApplicationStartup, type ApplicationStartupDependencies } from './applicationStartup';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const dependencies = () => ({
  install: mock(() => () => undefined), restore: mock(async () => false),
  initializeConfiguration: mock(async () => undefined), initializeLanguage: mock(async () => undefined),
  initializeSearch: mock(async () => undefined), installEffects: mock(() => () => undefined),
  render: mock(() => undefined), renderRecovery: mock(() => undefined),
  reload: mock(() => undefined), report: mock(() => undefined),
} satisfies ApplicationStartupDependencies);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

for (const stage of ['restore', 'initializeConfiguration', 'initializeLanguage'] as const) {
  test(`stopping while ${stage} is pending prevents subsequent startup and rendering`, async () => {
    const deps = dependencies();
    const pending = deferred<never>();
    deps[stage] = mock(() => pending.promise);
    const app = createApplicationStartup(deps);
    const startup = app.start();
    await flush();
    const stop = app.stop();
    pending.resolve(undefined as never);
    await Promise.all([startup, stop]);
    expect(deps.installEffects).not.toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.renderRecovery).not.toHaveBeenCalled();
    if (stage === 'restore') expect(deps.initializeConfiguration).not.toHaveBeenCalled();
    if (stage === 'initializeConfiguration') expect(deps.initializeSearch).not.toHaveBeenCalled();
  });
}
test('retired backup failure cannot start the recovery pipeline', async () => {
  const deps = dependencies();
  const pending = deferred<boolean>();
  deps.restore = mock(() => pending.promise);
  const app = createApplicationStartup(deps);
  const startup = app.start();
  await flush();
  const stop = app.stop();
  pending.reject(new Error('backup failed'));
  await Promise.all([startup, stop]);
  expect(deps.initializeLanguage).not.toHaveBeenCalled();
  expect(deps.renderRecovery).not.toHaveBeenCalled();
});
test('replacement waits for admitted work and ports survive until drainage', async () => {
  const pending = deferred<void>();
  const deps = dependencies();
  const dispose = mock(() => undefined);
  deps.install = mock(() => dispose);
  const old = createApplicationStartup(deps);
  await old.start();
  old.owner.track(pending.promise);
  const retirement = old.stop();
  expect(old.stop()).toBe(retirement);
  const nextDeps = dependencies();
  const next = createApplicationStartup(nextDeps);
  const startup = next.start(retirement);
  await flush();
  expect(dispose).not.toHaveBeenCalled();
  expect(nextDeps.install).not.toHaveBeenCalled();
  pending.resolve();
  await startup;
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(nextDeps.render).toHaveBeenCalledTimes(1);
  expect(next.start()).toBe(startup);
  await next.stop();
});
