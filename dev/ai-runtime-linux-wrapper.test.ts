import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import {
  createLinuxRuntimeWrapper,
  LINUX_RUNTIME_PAYLOAD_MARKER,
} from './ai-runtime-linux-wrapper.mjs';

const linuxOnlyTest = process.platform === 'win32' ? test.skip : test;

describe('Linux AI runtime wrapper', () => {
  test('keeps the compiled runtime intact behind a shell launcher', () => {
    const runtime = Buffer.from('compiled Bun runtime\0with binary data\xff');
    const { digest, wrapper } = createLinuxRuntimeWrapper(runtime);
    const marker = Buffer.from(`${LINUX_RUNTIME_PAYLOAD_MARKER}\n`);
    const payloadOffset = wrapper.indexOf(marker) + marker.length;

    expect(wrapper.subarray(0, 10).toString()).toBe('#!/bin/sh\n');
    expect(payloadOffset).toBeGreaterThan(marker.length);
    expect(gunzipSync(wrapper.subarray(payloadOffset, wrapper.lastIndexOf(Buffer.from('\n__')))))
      .toEqual(runtime);
    expect(digest).toBe(createHash('sha256').update(runtime).digest('hex'));
    expect(wrapper.subarray(0, payloadOffset).toString()).toContain(
      `macro-ai-runtime-${digest}`
    );
  });

  linuxOnlyTest('extracts and executes the embedded runtime', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'macro-ai-runtime-wrapper-'));
    const wrapperPath = join(temporaryDirectory, 'macro-ai-runtime');
    const runtime = Buffer.from('#!/bin/sh\nprintf \'runtime:%s\\n\' "$1"\n');
    const { wrapper } = createLinuxRuntimeWrapper(runtime);

    try {
      await writeFile(wrapperPath, wrapper);
      await chmod(wrapperPath, 0o755);

      const syntaxCheck = spawnSync('sh', ['-n', wrapperPath], { encoding: 'utf8' });
      const execution = spawnSync(wrapperPath, ['healthy'], {
        encoding: 'utf8',
        env: { ...process.env, XDG_CACHE_HOME: join(temporaryDirectory, 'cache') },
      });

      expect(syntaxCheck.status).toBe(0);
      expect(execution.status).toBe(0);
      expect(execution.stdout).toBe('runtime:healthy\n');
      expect(execution.stderr).toBe('');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
