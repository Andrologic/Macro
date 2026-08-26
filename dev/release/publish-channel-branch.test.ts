import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { publishChannelBranch } from './publish-channel-branch.mjs';

const roots: string[] = [];

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'macro-channel-branch-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  git(root, 'init', '--bare', remote);
  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'Test');
  git(seed, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  git(root, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  return { root, remote };
}

function clone(remote: string, destination: string): string {
  git(join(destination, '..'), 'clone', remote, destination);
  return destination;
}

function manifests(root: string, channel: 'stable' | 'preview', version: string): string {
  const directory = join(root, `${channel}-${version}`);
  mkdirSync(directory);
  writeFileSync(join(directory, `${channel}-windows-x86_64.json`), `${version}\n`);
  writeFileSync(join(directory, `${channel}-linux-x86_64.json`), `${version}\n`);
  return directory;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('update channel branch publication', () => {
  test('bootstraps the orphan branch and preserves the other channel on later publications', () => {
    const { root, remote } = fixture();
    const stableRepository = clone(remote, join(root, 'stable-repository'));
    const first = publishChannelBranch({
      repositoryDirectory: stableRepository,
      manifestsDirectory: manifests(root, 'stable', '0.1.1'),
      channel: 'stable',
      label: 'v0.1.1',
    });
    expect(first.changed).toBe(true);

    const previewRepository = clone(remote, join(root, 'preview-repository'));
    const second = publishChannelBranch({
      repositoryDirectory: previewRepository,
      manifestsDirectory: manifests(root, 'preview', '0.1.2-rc.1'),
      channel: 'preview',
      label: '0.1.2-rc.1',
    });
    expect(second.changed).toBe(true);

    const audit = clone(remote, join(root, 'audit'));
    git(audit, 'switch', '--track', 'origin/updates');
    expect(readFileSync(join(audit, 'channels/stable-windows-x86_64.json'), 'utf8').trim()).toBe('0.1.1');
    expect(readFileSync(join(audit, 'channels/preview-windows-x86_64.json'), 'utf8').trim()).toBe('0.1.2-rc.1');
  });

  test('removes stale manifests only from the channel being published', () => {
    const { root, remote } = fixture();
    const initialRepository = clone(remote, join(root, 'initial-repository'));
    const initialManifests = manifests(root, 'stable', '0.1.1');
    writeFileSync(join(initialManifests, 'stable-retired-target.json'), 'retired\n');
    publishChannelBranch({
      repositoryDirectory: initialRepository,
      manifestsDirectory: initialManifests,
      channel: 'stable',
      label: 'v0.1.1',
    });

    const previewRepository = clone(remote, join(root, 'preview-preservation'));
    publishChannelBranch({
      repositoryDirectory: previewRepository,
      manifestsDirectory: manifests(root, 'preview', '0.1.2-rc.1'),
      channel: 'preview',
      label: '0.1.2-rc.1',
    });

    const replacementRepository = clone(remote, join(root, 'replacement-repository'));
    publishChannelBranch({
      repositoryDirectory: replacementRepository,
      manifestsDirectory: manifests(root, 'stable', '0.1.2'),
      channel: 'stable',
      label: 'v0.1.2',
    });

    const audit = clone(remote, join(root, 'stale-audit'));
    git(audit, 'switch', '--track', 'origin/updates');
    expect(() => readFileSync(join(audit, 'channels/stable-retired-target.json'), 'utf8')).toThrow();
    expect(readFileSync(join(audit, 'channels/preview-windows-x86_64.json'), 'utf8').trim()).toBe('0.1.2-rc.1');
  });

  test('does not create another commit when the selected channel is unchanged', () => {
    const { root, remote } = fixture();
    const firstRepository = clone(remote, join(root, 'first-repository'));
    const stableManifests = manifests(root, 'stable', '0.1.1');
    publishChannelBranch({
      repositoryDirectory: firstRepository,
      manifestsDirectory: stableManifests,
      channel: 'stable',
      label: 'v0.1.1',
    });

    const secondRepository = clone(remote, join(root, 'second-repository'));
    const before = git(secondRepository, 'rev-parse', 'origin/updates');
    const result = publishChannelBranch({
      repositoryDirectory: secondRepository,
      manifestsDirectory: stableManifests,
      channel: 'stable',
      label: 'v0.1.1',
    });
    const after = git(secondRepository, 'rev-parse', 'origin/updates');

    expect(result.changed).toBe(false);
    expect(after).toBe(before);
  });

  test('rejects unsupported channels and empty manifest directories', () => {
    const { root, remote } = fixture();
    const repository = clone(remote, join(root, 'repository'));
    const empty = join(root, 'empty');
    mkdirSync(empty);

    expect(() => publishChannelBranch({
      repositoryDirectory: repository,
      manifestsDirectory: empty,
      channel: 'beta' as 'stable',
      label: 'v0.1.1',
    })).toThrow('Unsupported update channel');
    expect(() => publishChannelBranch({
      repositoryDirectory: repository,
      manifestsDirectory: empty,
      channel: 'stable',
      label: 'v0.1.1',
    })).toThrow('No stable channel manifests');
  });
});
