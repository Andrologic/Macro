import { expect, it, mock } from 'bun:test';
it('refuses importing the browser fixture outside explicit Vite DEV before any request', async () => {
  const original = globalThis.fetch; const requests = mock(() => { throw new Error('No external request permitted'); });
  globalThis.fetch = requests as unknown as typeof fetch;
  try { await expect(import('./connect-consumer-qa')).rejects.toThrow('Synthetic Connect QA requires DEV and loopback.'); expect(requests).not.toHaveBeenCalled(); }
  finally { globalThis.fetch = original; }
});
