import { expect, it, mock } from 'bun:test';

it('rejects the archive QA entry before loading conversation code outside explicit Vite DEV', async () => {
  const original = globalThis.fetch;
  const requests = mock(() => { throw new Error('No request permitted'); });
  globalThis.fetch = requests as unknown as typeof fetch;
  try {
    await expect(import('./archive-reader-qa')).rejects.toThrow('Archive history QA requires DEV and loopback.');
    expect(requests).not.toHaveBeenCalled();
  } finally { globalThis.fetch = original; }
});
