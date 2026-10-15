// Install the synthetic transport before any application store is imported.
if (import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1') {
  const { installDemoRuntime } = await import('./demo/install');
  await installDemoRuntime();
}
await import('./main');
export {};
