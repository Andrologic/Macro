import { beforeEach, afterEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import { useAppStore } from '../stores/useAppStore';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import { recoverArchitectPlanReplicaMutations } from './architectPlanMutationPersistence';
import { resolveArchitectPlanServiceDependencies } from './architectPlanReadContext';
import * as initialService from './architectPlanArtifactService';

const branchName = 'develop';
const plan: ArchitectPlanRecord = {
  id: 'plan-1', slug: 'plan-1', title: 'Synthetic plan', description: '', status: 'in_progress',
  targetBranch: branchName, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  projectIds: ['a', 'b'], predictedBranches: [],
  nodes: [{ id: 'task', title: 'Task', type: 'task', status: 'pending', dependencies: [] }],
};
const task = { id: 'task', task_source: 'architect', plan_id: 'plan-1', plan_storage_branch: branchName, dependencies: [], execution_targets: [] } as unknown as CatalogedImplementTask;
const roots = ['/synthetic/a', '/synthetic/b'];
const manifestPath = 'branches/develop/plans/plan-1/manifest.json';
const journalKey = 'pendingArchitectPlanReplicaMutations:v1';
const files = new Map<string, string>();
const settings = new Map<string, string>();
const key = (root: string, path: string) => `${root}::${path}`;
let service = initialService;
let writes = 0;
let onWrite: (() => void | Promise<void>) | undefined;
let onRead: ((path: string) => void) | undefined;
let onSetting: ((value: string) => void) | undefined;
let importId = 0;
const restart = async () => {
  service = await import(`./architectPlanArtifactService.ts?recovery=${++importId}`);
};
const put = (content: string) => service.putTaskArtifact({
  target: { branchName, plan, task, currentTask: task },
  args: { title: 'Notes', artifact_id: 'notes', content },
});
const read = () => service.readPlanTaskArtifactIndex({ branchName, planId: plan.id, projectIds: plan.projectIds });
const restore = (target: Map<string, string>, snapshot: Map<string, string>) => {
  target.clear();
  for (const [path, value] of snapshot) target.set(path, value);
};

beforeEach(() => {
  files.clear(); settings.clear(); writes = 0; onWrite = undefined; onRead = undefined; onSetting = undefined;
  useAppStore.setState({
    standaloneProjects: roots.map((path, i) => ({
      id: i === 0 ? 'a' : 'b', name: 'Synthetic', path, mountName: `synthetic-${i}`,
      created_at: '', status: 'active', gitSetupState: 'ready', directEdit: false,
      metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
    })), projectGroups: [], selectedProjectId: 'a', selectedGroupId: null,
  });
  for (const root of roots) files.set(key(root, manifestPath), JSON.stringify({ version: 3 }));
  installTauriRuntimeMock(mock(async (command, payload) => {
    const p = payload as Record<string, unknown>;
    const path = key(String(p?.workspacePath), String(p?.path));
    if (command === 'workspace_get_active_root') return roots[0];
    if (command === 'db_get_app_setting') {
      const value = settings.get(String(p.key));
      return value === undefined ? null : { value_json: value };
    }
    if (command === 'db_compare_and_swap_app_setting') {
      if ((settings.get(String(p.key)) ?? null) !== p.expectedValueJson) return { applied: false };
      onSetting?.(String(p.valueJson));
      settings.set(String(p.key), String(p.valueJson));
      return { applied: true };
    }
    if (command === 'fs_exists') return files.has(path);
    if (command === 'fs_read_file') {
      onRead?.(path);
      if (!files.has(path)) throw new Error('missing file');
      return { content: files.get(path), revision: files.get(path) };
    }
    if (command === 'fs_write_file' || command === 'fs_delete') {
      if (p.expectedRevision != null && p.expectedRevision !== (files.get(path) ?? 'absent')) throw new Error('revision conflict');
      if (command === 'fs_write_file') files.set(path, String(p.content));
      else files.delete(path);
      writes += 1;
      await onWrite?.();
      return {};
    }
    return undefined;
  }));
});
afterEach(() => {
  removeTauriRuntimeMock();
  useAppStore.setState({ standaloneProjects: [], projectGroups: [], selectedProjectId: null, selectedGroupId: null });
});

describe('artifact durable recovery', () => {
  for (const existing of [false, true]) {
    for (const stopAfter of [1, 2, 3, 4, 5, 6]) {
      it(`recovers ${existing ? 'overwrite' : 'creation'} after durable file ${stopAfter} of six`, async () => {
        if (existing) await put('Original content');
        const before = new Map(files);
        let diskAtCrash!: Map<string, string>;
        let settingsAtCrash!: Map<string, string>;
        writes = 0;
        onWrite = () => {
          if (writes !== stopAfter) return;
          onWrite = undefined;
          diskAtCrash = new Map(files);
          settingsAtCrash = new Map(settings);
          throw new Error('simulated process loss');
        };
        await expect(put('Replacement content')).rejects.toThrow();
        expect(files).toEqual(before); // Same-process rollback.
        // Retain exactly the durable state at the interruption, discarding catch/finally effects.
        restore(files, diskAtCrash); restore(settings, settingsAtCrash);
        await restart();
        // Reopening through Plans must also resolve artifact intents, before loading replicas.
        await recoverArchitectPlanReplicaMutations(resolveArchitectPlanServiceDependencies({
          getAppState: () => useAppStore.getState(),
        }));
        await read();
        expect(files).toEqual(before);
        expect(JSON.parse(settings.get(journalKey) || '[]')).toEqual([]);
        await read();
        expect(files).toEqual(before);
      });
    }
  }

  for (const stopAfter of [1, 2, 3, 4]) {
    it(`rolls back an interrupted validation after metadata file ${stopAfter}`, async () => {
      const artifact = await put('Original');
      const before = new Map(files);
      let diskAtCrash!: Map<string, string>;
      let settingsAtCrash!: Map<string, string>;
      writes = 0;
      onWrite = () => {
        if (writes !== stopAfter) return;
        onWrite = undefined;
        diskAtCrash = new Map(files); settingsAtCrash = new Map(settings);
        throw new Error('interrupted validation');
      };
      await expect(service.validateVisibleTaskArtifact({ branchName, plan, task, artifactId: artifact.id })).rejects.toThrow();
      restore(files, diskAtCrash); restore(settings, settingsAtCrash);
      await restart();
      expect((await read()).reviews).toEqual([]);
      expect(files).toEqual(before);
      expect(await service.loadUnvalidatedCurrentTaskArtifactsForCompletion(task, async () => plan)).toHaveLength(1);
    });
  }

  for (const markerPersisted of [false, true]) {
    it(`resolves an uncertain commit marker with durable marker=${markerPersisted}`, async () => {
      await put('Original');
      const before = new Map(files);
      onSetting = (value) => {
        if (JSON.parse(value)[0]?.phase !== 'files_applied') return;
        if (markerPersisted) settings.set(journalKey, value);
        throw new Error('lost marker response');
      };
      await expect(put('Replacement')).rejects.toThrow('lost marker response');
      const after = new Map(files);
      onSetting = undefined;
      await restart();
      await read();
      expect(files).toEqual(markerPersisted ? after : before);
      expect(JSON.parse(settings.get(journalKey)!)).toEqual([]);
    });
  }

  it('keeps a committed update after journal cleanup fails and reopens idempotently', async () => {
    await put('Original');
    onSetting = (value) => { if (value === '[]') throw new Error('cleanup unavailable'); };
    await expect(put('Committed replacement')).rejects.toThrow('cleanup unavailable');
    const committed = new Map(files);
    expect(JSON.parse(settings.get(journalKey)!)[0].phase).toBe('files_applied');
    onSetting = undefined;
    await restart();
    await read();
    expect(files).toEqual(committed);
    expect(JSON.parse(settings.get(journalKey)!)).toEqual([]);
    await read();
    expect(files).toEqual(committed);
  });

  it('does not write when the durable intent cannot be persisted', async () => {
    const before = new Map(files);
    onSetting = () => { throw new Error('journal unavailable'); };
    await expect(put('New')).rejects.toThrow('journal unavailable');
    expect(files).toEqual(before);
    expect(writes).toBe(0);
  });

  it('keeps before-images and blocks reopening while a rollback file is unreadable', async () => {
    await put('Original');
    const before = new Map(files);
    onWrite = () => {
      onWrite = undefined;
      onRead = () => { throw new Error('disk unavailable'); };
      throw new Error('write failed');
    };
    await expect(put('Replacement')).rejects.toThrow('disk unavailable');
    expect(JSON.parse(settings.get(journalKey)!)).toHaveLength(1);
    await restart();
    await expect(read()).rejects.toThrow('disk unavailable');
    onRead = undefined;
    await read();
    expect(files).toEqual(before);
  });

  it('preserves an external edit and retains the recovery intent instead of overwriting it', async () => {
    const artifact = await put('Original');
    const path = key(roots[0]!, artifact.path);
    onWrite = () => {
      onWrite = undefined;
      files.set(path, 'External edit');
      throw new Error('write failed');
    };
    await expect(put('Replacement')).rejects.toThrow('recovery conflict');
    await restart();
    await expect(read()).rejects.toThrow('recovery conflict');
    expect(files.get(path)).toBe('External edit');
    expect(JSON.parse(settings.get(journalKey)!)[0].payload.files[0].before).toBe('Original');
  });

  for (const corruption of ['content', 'missing-content', 'index', 'missing-index', 'manifest', 'missing-summary', 'invalid-entry', 'wrong-plan']) {
    it(`refuses validation and completion with ${corruption} corruption`, async () => {
      const artifact = await put('Original');
      await service.validateVisibleTaskArtifact({ branchName, plan, task, artifactId: artifact.id });
      const indexPath = service.getPlanArtifactIndexPath(branchName, plan.id);
      if (corruption === 'content') files.set(key(roots[1]!, artifact.path), 'Other content');
      if (corruption === 'missing-content') files.delete(key(roots[1]!, artifact.path));
      if (corruption === 'index') {
        const index = JSON.parse(files.get(key(roots[1]!, indexPath))!);
        index.artifacts[0].summary = 'Other replica';
        files.set(key(roots[1]!, indexPath), JSON.stringify(index));
      }
      if (corruption === 'missing-index') for (const root of roots) files.delete(key(root, indexPath));
      if (corruption === 'manifest') files.set(key(roots[1]!, manifestPath), JSON.stringify({ artifacts: { count: 99 } }));
      if (corruption === 'missing-summary') files.set(key(roots[1]!, manifestPath), '{}');
      if (corruption === 'wrong-plan') {
        const index = JSON.parse(files.get(key(roots[1]!, indexPath))!);
        index.artifacts[0].planId = 'other-plan';
        files.set(key(roots[1]!, indexPath), JSON.stringify(index));
      }
      if (corruption === 'invalid-entry') {
        const index = JSON.parse(files.get(key(roots[1]!, indexPath))!);
        index.artifacts.push({ id: 'broken' });
        files.set(key(roots[1]!, indexPath), JSON.stringify(index));
      }
      const before = new Map(files);
      await expect(service.validateVisibleTaskArtifact({ branchName, plan, task, artifactId: artifact.id })).rejects.toThrow();
      await expect(service.listVisibleTaskArtifactReviewEntries({ branchName, plan, task })).rejects.toThrow();
      await expect(service.loadUnvalidatedCurrentTaskArtifactsForCompletion(task, async () => plan)).rejects.toThrow();
      expect(files).toEqual(before);
    });
  }

  it('serializes a recovery read behind an active artifact write', async () => {
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    onWrite = async () => { onWrite = undefined; entered(); await gate; };
    const mutation = put('Concurrent');
    await writing;
    let readFinished = false;
    const reader = read().then((value) => { readFinished = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFinished).toBe(false);
    release();
    await mutation;
    expect((await reader).artifacts).toHaveLength(1);
  });

  it('keeps artifacts readable and reviewable for catalog runtime task identities', async () => {
    const catalogTask = { ...task, id: 'task:v1:develop:plan-1:task', node_id: 'task' };
    const artifact = await service.putTaskArtifact({
      target: { branchName, plan, task: catalogTask, currentTask: catalogTask },
      args: { title: 'Catalog notes', content: 'Catalog content' },
    });
    expect((await read()).artifacts).toHaveLength(1);
    expect(await service.listVisibleTaskArtifacts({ branchName, plan, task: catalogTask })).toHaveLength(1);
    await service.validateVisibleTaskArtifact({ branchName, plan, task: catalogTask, artifactId: artifact.id });
    expect(await service.loadUnvalidatedCurrentTaskArtifactsForCompletion(catalogTask, async () => plan)).toEqual([]);
  });

  it('blocks an invalid artifact journal scope without writing or discarding the intent', async () => {
    settings.set(journalKey, JSON.stringify([{
      id: 'bad-scope', branchName, planId: plan.id, workspaceKey: roots.join('|'),
      operation: 'artifacts', phase: 'prepared', createdAt: 'now', updatedAt: 'now',
      payload: { files: [{ workspacePath: '/foreign', workspaceScope: 'metadata',
        path: manifestPath, before: null, after: '{}' }] },
    }]));
    await expect(read()).rejects.toThrow('Invalid artifact recovery intent');
    expect(writes).toBe(0);
    expect(JSON.parse(settings.get(journalKey)!)).toHaveLength(1);
  });
});
