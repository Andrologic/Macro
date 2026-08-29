import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const stepByName = (jobName: string, stepName: string) => (
  workflow.jobs[jobName].steps.find((step: { name?: string }) => step.name === stepName)
);

describe('GitHub CI routing', () => {
  test('publishes the sidecar classification with a conservative fallback', () => {
    expect(workflow.jobs.classify.outputs.sidecar).toBe('${{ steps.changes.outputs.sidecar }}');
    expect(stepByName('classify', 'Classify changed paths').run).toContain('echo "sidecar=true"');
  });

  test('installs frontend dependencies only when a selected check needs them', () => {
    const linuxInstall = stepByName('linux', 'Install locked frontend dependencies');
    expect(linuxInstall.if).toContain("outputs.frontend == 'true'");
    expect(linuxInstall.if).toContain("outputs.sidecar == 'true'");
    expect(linuxInstall.if).toContain("outputs.configuration == 'true'");

    const windowsInstall = stepByName('windows', 'Install locked frontend dependencies');
    expect(windowsInstall.if).toContain("outputs.sidecar == 'true'");
    expect(windowsInstall.if).toContain("outputs.configuration == 'true'");
    expect(windowsInstall.if).not.toContain('outputs.native');
  });

  test('keeps focused and conservative profiles separate', () => {
    expect(stepByName('linux', 'Run shared frontend validation profile').run)
      .toContain('--profile frontend --skip-install');
    expect(stepByName('linux', 'Run focused native validation profile').run)
      .toContain('--profile native-core');
    expect(stepByName('linux', 'Build changed AI runtime sidecar').run)
      .toContain('--profile sidecar --skip-install');
    expect(stepByName('linux', 'Run conservative validation profile').run)
      .toContain('--profile native --skip-install');

    expect(stepByName('windows', 'Run focused Windows native profile').run)
      .toContain('--profile windows-core');
    expect(stepByName('windows', 'Build changed Windows AI runtime sidecar').run)
      .toContain('--profile sidecar --skip-install');
    expect(stepByName('windows', 'Run conservative Windows validation profile').run)
      .toContain('--profile windows --skip-install');
  });

  test('keys dependency caches by platform, architecture, Bun, and lock state', () => {
    for (const jobName of ['linux', 'windows']) {
      const cache = stepByName(jobName, 'Restore frontend dependency cache');
      expect(cache.with.path).toBe('node_modules');
      expect(cache.with.key).toContain('${{ runner.os }}');
      expect(cache.with.key).toContain('${{ runner.arch }}');
      expect(cache.with.key).toContain('bun-1.3.14');
      expect(cache.with.key).toContain("hashFiles('package.json', 'bun.lock')");
    }
  });
});
