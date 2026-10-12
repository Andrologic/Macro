import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import { useAppStore } from '../stores/useAppStore';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import { withReplicaTransactionLock, resolveReplicaWorkspaceKey } from './architectPlanMutationPersistence';
import { resolveArchitectPlanServiceDependencies } from './architectPlanReadContext';
import { buildValidProjectRegistrySnapshot } from './validProjectRegistry';
import {
  createPilotTaskArtifactExportBudget, getPlanArtifactContentPath, getPlanArtifactIndexPath,
  listPilotTaskArtifactExports, readPilotTaskArtifactExport, readPilotTaskArtifactPlanSnapshot, taskArtifactContentHash,
  PILOT_TASK_ARTIFACT_EXPORT_LIMITS as limits,
} from './architectPlanArtifactService';

const branchName = 'feature/artifacts';
const task = { id: 'child', plan_id: 'plan-1', task_source: 'architect', dependencies: ['parent'] } as CatalogedImplementTask;
const plan = { id: 'plan-1', status: 'draft', projectIds: ['project-0'],
  nodes: [{ id: 'parent', dependencies: [] }, { id: 'child', dependencies: ['parent'] },
    { id: 'sibling', dependencies: [] }], replicas: [] } as unknown as ArchitectPlanRecord;
const indexPath = getPlanArtifactIndexPath(branchName, plan.id);
const manifestPath = `branches/${branchName}/plans/${plan.id}/manifest.json`;
const params = { branchName, plan, task };
const files = new Map<string, string>();
const reads: Array<{ path: string; workspacePath: string; workspaceScope: string }> = [];
const commands: string[] = [];
const oversizedStats = new Map<string, number>();
let hook: ((path: string, workspacePath: string) => void) | undefined;
const digest = (text: string) => bytesToHex(sha256(new TextEncoder().encode(text)));
const projectMetadata = { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] };

const register = (count: number, direct = false) => {
  plan.projectIds = Array.from({ length: count }, (_, i) => `project-${i}`);
  plan.executionModesByProjectId = direct ? Object.fromEntries(plan.projectIds.map((id) => [id, 'direct'])) : {};
  useAppStore.setState({ standaloneProjects: plan.projectIds.map((id, i) => ({ id, name: id, mountName: id,
    path: `/synthetic/project-${i}`, created_at: '', status: 'active', gitSetupState: 'ready', directEdit: direct,
    metadata: projectMetadata })), projectGroups: [], selectedProjectId: null, selectedGroupId: null });
};
const artifact = (id: string, node: string, content: string) => ({ id, planId: plan.id, taskId: node,
  path: getPlanArtifactContentPath(branchName, plan.id, node, id, 'text'), contentType: 'text',
  contentHash: taskArtifactContentHash(content), kind: 'note', title: id, summary: '',
  createdAt: '2026-01-01', updatedAt: '2026-01-01', createdBy: 'agent' });
const seed = (entries = [artifact('result', 'child', 'Bonjour é\n')]) => {
  files.set(indexPath, JSON.stringify({ schemaVersion: 1, planId: plan.id, updatedAt: '2026-01-01', artifacts: entries }));
  for (const entry of entries) files.set(entry.path, 'Bonjour é\n');
  return entries;
};
const captureParams = (entry: Awaited<ReturnType<typeof listPilotTaskArtifactExports>>['entries'][number]) => ({
  ...params, artifactId: entry.artifact.id, expectedSha256: entry.sha256!, expectedTotalBytes: entry.totalBytes,
});

beforeEach(() => {
  files.clear(); oversizedStats.clear(); reads.length = 0; commands.length = 0; hook = undefined;
  plan.status = 'draft'; plan.replicas = []; register(1);
  installTauriRuntimeMock(mock(async (command, payload) => {
    commands.push(command);
    const path = String(payload?.path || '');
    const workspacePath = String(payload?.workspacePath || '');
    if (command === 'workspace_get_active_root') throw new Error('Fallback must not be used.');
    if (command === 'fs_exists') return files.has(`${workspacePath}::${path}`) || files.has(path);
    if (command === 'fs_stat') {
      const text = files.get(`${workspacePath}::${path}`) ?? files.get(path);
      if (text === undefined) throw new Error('Missing file.');
      return { kind: 'file', size: oversizedStats.get(path) ?? Buffer.byteLength(text) };
    }
    if (command === 'fs_read_file') {
      reads.push({ path, workspacePath, workspaceScope: String(payload?.workspaceScope) });
      expect(payload?.allowOutsideWorkspace).toBe(false);
      hook?.(path, workspacePath);
      const content = files.get(`${workspacePath}::${path}`) ?? files.get(path);
      if (content === undefined) throw new Error('Missing file.');
      return { content, revision: 'untrusted-native-revision' };
    }
    throw new Error(`Unexpected effect: ${command}`);
  }));
});
afterEach(() => {
  removeTauriRuntimeMock();
  useAppStore.setState({ standaloneProjects: [], projectGroups: [], selectedProjectId: null, selectedGroupId: null });
});

describe('Pilot read-only artifact export', () => {
  it('lists artifacts over the native read ceiling as too_large without reading their bytes', async () => {
    const [large, small] = seed([artifact('large', 'child', 'Bonjour é\n'), artifact('small', 'child', 'Bonjour é\n')]);
    oversizedStats.set(large!.path, limits.nativeFileBytes + 1);
    const catalog = await listPilotTaskArtifactExports(params);
    try {
      expect(catalog.entries.find((entry) => entry.artifact.id === 'large')).toMatchObject({ contentState: 'too_large', sha256: null, totalBytes: limits.nativeFileBytes + 1 });
      expect(reads.some((read) => read.path === large!.path)).toBe(false);
      const source = await readPilotTaskArtifactExport(captureParams(catalog.entries.find((entry) => entry.artifact.id === 'small')!));
      try { expect(source.bytes).toEqual(new TextEncoder().encode('Bonjour é\n')); } finally { source.release(); }
      expect(reads.some((read) => read.path === small!.path)).toBe(true);
    } finally { catalog.release(); }
  });

  it('attests UTF-8 bytes, filters task visibility and uses existing metadata without recovery effects', async () => {
    const entries = seed([artifact('result', 'child', 'Bonjour é\n'), artifact('inherited', 'parent', 'Bonjour é\n'),
      artifact('private', 'sibling', 'Bonjour é\n')]);
    const catalog = await listPilotTaskArtifactExports(params);
    try {
      expect(catalog.entries.map((entry) => entry.artifact.id)).toEqual(['result', 'inherited']);
      expect(catalog.entries[0]).toMatchObject({ sha256: digest('Bonjour é\n'), totalBytes: 11 });
      const result = await readPilotTaskArtifactExport(captureParams(catalog.entries[0]!));
      try { expect(new TextDecoder().decode(result.bytes)).toBe('Bonjour é\n'); }
      finally { result.release(); }
      expect(reads.every((read) => read.workspaceScope === 'metadata_existing')).toBe(true);
      expect(reads.some((read) => read.path === entries[2]!.path)).toBe(false);
      expect(commands.every((command) => command === 'fs_read_file' || command === 'fs_exists' || command === 'fs_stat')).toBe(true);
      await expect(readPilotTaskArtifactExport({ ...params, artifactId: 'private', expectedSha256: digest('Bonjour é\n'), expectedTotalBytes: 11 })).rejects.toThrow('not visible');
    } finally { catalog.release(); }
  });

  it('rejects the reproduced equal-length FNV collision after a catalog or capture', async () => {
    const before = 'audit-2b7a8c568e923c6dc256';
    const after = 'audit-ee22858f3f5118aaaf53';
    expect(taskArtifactContentHash(before)).toBe(taskArtifactContentHash(after));
    const [entry] = seed([artifact('result', 'child', before)]);
    files.set(entry!.path, before);
    const catalog = await listPilotTaskArtifactExports(params);
    try {
      const request = captureParams(catalog.entries[0]!);
      const capture = await readPilotTaskArtifactExport(request);
      capture.release();
      files.set(entry!.path, after);
      await expect(readPilotTaskArtifactExport(request)).rejects.toThrow('attestation changed');
      const fresh = await listPilotTaskArtifactExports(params);
      try { expect(fresh.entries[0]!.sha256).toBe(digest(after)); }
      finally { fresh.release(); }
    } finally { catalog.release(); }
  });

  it('rejects colliding content divergence between replicas', async () => {
    register(2);
    const before = 'audit-2b7a8c568e923c6dc256';
    const [entry] = seed([artifact('result', 'child', before)]);
    files.set(entry!.path, before);
    files.set(`/synthetic/project-1::${entry!.path}`, 'audit-ee22858f3f5118aaaf53');
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('content replicas diverge');
  });

  it('rejects a 3 MiB summary before parsing or reading content, even with 24 replicas', async () => {
    register(24);
    const [entry] = seed();
    const raw = JSON.parse(files.get(indexPath)!);
    raw.artifacts[0].summary = 'q'.repeat(3 * 1024 * 1024);
    files.set(indexPath, JSON.stringify(raw));
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('size limit');
    expect(reads.map((read) => read.path)).toEqual([indexPath]);
    expect(reads.some((read) => read.path === entry!.path)).toBe(false);
  });

  it('compares 24 replicas within one bounded reservation and releases retained metadata', async () => {
    register(24); seed();
    const budget = createPilotTaskArtifactExportBudget();
    let retained = 0; let peak = 0;
    const catalog = await listPilotTaskArtifactExports({ ...params, budget: { reserve(bytes) {
      const release = budget.reserve(bytes);
      retained += bytes; peak = Math.max(peak, retained);
      return () => { retained -= bytes; release(); };
    } } });
    expect(reads.filter((read) => read.path === indexPath)).toHaveLength(24);
    expect(catalog.entries).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(limits.aggregateBytes);
    expect(retained).toBeLessThan(limits.metadataBytes * 2);
    expect(retained).toBeGreaterThan(0);
    catalog.release(); catalog.release();
    expect(retained).toBe(0);
  });

  it('reserves the native maximum before IPC and fails without reading when the parent refuses', async () => {
    seed(); const reservations: number[] = [];
    await expect(listPilotTaskArtifactExports({ ...params, budget: { reserve(bytes) {
      reservations.push(bytes);
      if (bytes === limits.nativeWorkingBytes) throw new Error('Host budget exhausted.');
      return () => {};
    } } })).rejects.toThrow('Host budget exhausted');
    expect(reservations).toEqual([8 * 1024 * 1024, limits.nativeWorkingBytes]);
    expect(reads).toHaveLength(0);
    const ok = await listPilotTaskArtifactExports(params); ok.release();
  });

  it('caps artifact count and replica count before content reads', async () => {
    seed(Array.from({ length: 2001 }, (_, i) => artifact(`a-${i}`, 'child', 'Bonjour é\n')));
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('oversized');
    expect(reads).toHaveLength(1);
    reads.length = 0; register(33);
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('bounded registered');
    expect(reads).toHaveLength(0);
  });

  it('rejects an oversized manifest, missing or divergent index replicas, and invalid paths', async () => {
    seed(); files.set(manifestPath, ' '.repeat(limits.metadataBytes + 1));
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('size limit');
    files.delete(manifestPath); register(2);
    files.set(`/synthetic/project-1::${indexPath}`, JSON.stringify({ schemaVersion: 1, planId: plan.id, artifacts: [], updatedAt: '2026-01-01' }));
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('index replicas diverge');
    files.clear();
    files.set(`/synthetic/project-0::${indexPath}`, JSON.stringify({ schemaVersion: 1, planId: plan.id, artifacts: [], updatedAt: '2026-01-01' }));
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('replica is missing');
    files.clear(); register(1); const [entry] = seed();
    files.set(indexPath, JSON.stringify({ schemaVersion: 1, planId: plan.id, artifacts: [{ ...entry, path: '/private/arbitrary.txt' }] }));
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('Invalid artifact content path');
    expect(reads.some((read) => read.path === '/private/arbitrary.txt')).toBe(false);
  });

  it('keeps direct scope and rejects unregistered fallback and stale task contexts', async () => {
    register(1, true); seed();
    const catalog = await listPilotTaskArtifactExports(params); catalog.release();
    expect(reads.every((read) => read.workspaceScope === 'direct')).toBe(true);
    register(0); plan.replicas = [{ repoPath: '/unregistered/private' }] as ArchitectPlanRecord['replicas'];
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('bounded registered');
    expect(commands).not.toContain('workspace_get_active_root');
    register(1);
    await expect(listPilotTaskArtifactExports({ ...params, task: { ...task, plan_id: 'other' } })).rejects.toThrow('plan context');
    await expect(listPilotTaskArtifactExports({ ...params, task: { ...task, task_source: 'standalone' } })).rejects.toThrow('planned Architect');
  });

  it('waits on the workflow transaction lock without running recovery', async () => {
    seed();
    const deps = resolveArchitectPlanServiceDependencies({ getAppState: () => useAppStore.getState() });
    const key = await resolveReplicaWorkspaceKey(deps, buildValidProjectRegistrySnapshot(useAppStore.getState()));
    let unblock!: () => void;
    const blocked = withReplicaTransactionLock(key, () => new Promise<void>((resolve) => { unblock = resolve; }));
    await Promise.resolve();
    const exportPromise = listPilotTaskArtifactExports(params);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toHaveLength(0);
    unblock(); await blocked;
    const catalog = await exportPromise; catalog.release();
    expect(commands.every((command) => command === 'fs_read_file' || command === 'fs_exists' || command === 'fs_stat')).toBe(true);
  });


  it('runs the fixed-deadline guard before every native access and stops expired replicas', async () => {
    register(24); seed();
    let guarded = false;
    let calls = 0;
    hook = () => { expect(guarded).toBe(true); guarded = false; };
    await expect(listPilotTaskArtifactExports({ ...params, beforeRead: async () => {
      calls += 1;
      if (reads.length >= 3) throw new Error('Fixed deadline expired.');
      guarded = true;
    } })).rejects.toThrow('Fixed deadline expired');
    expect(calls).toBeGreaterThan(reads.length);
    expect(reads).toHaveLength(3);
    hook = undefined;
    const catalog = await listPilotTaskArtifactExports(params);
    try {
      reads.length = 0;
      await expect(readPilotTaskArtifactExport({ ...captureParams(catalog.entries[0]!),
        beforeRead: async () => { throw new Error('Expired before revalidation.'); },
      })).rejects.toThrow('Expired before revalidation');
      expect(reads).toHaveLength(0);
    } finally { catalog.release(); }
  });

  it('rejects a file growing beyond the native cap after its size observation', async () => {
    const content = 'x'.repeat(limits.nativeFileBytes + 1);
    const [entry] = seed([artifact('result', 'child', content)]);
    files.set(entry!.path, content);
    oversizedStats.set(entry!.path, 1);
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('size limit');
  });

  it('accepts 2000 entries and releases metadata transferred from working space', async () => {
    seed(Array.from({ length: limits.artifacts }, (_, i) => artifact(`a-${i}`, 'child', 'Bonjour é\n')));
    let retained = 0;
    const catalog = await listPilotTaskArtifactExports({ ...params, budget: { reserve(bytes) {
      retained += bytes;
      return () => { retained -= bytes; };
    } } });
    expect(catalog.entries).toHaveLength(limits.artifacts);
    expect(retained).toBeLessThan(8 * 1024 * 1024);
    expect(retained).toBeGreaterThan(0);
    catalog.release();
    expect(retained).toBe(0);
  });

  it('leaves files above 2 MiB unattested and refuses their re-read before native access', async () => {
    const content = 'é'.repeat(limits.exportedFileBytes / 2 + 1);
    const [entry] = seed([artifact('result', 'child', content)]);
    files.set(entry!.path, content);
    const catalog = await listPilotTaskArtifactExports(params);
    try {
      expect(catalog.entries[0]).toMatchObject({ sha256: null, totalBytes: limits.exportedFileBytes + 2, contentState: 'too_large' });
      reads.length = 0;
      await expect(readPilotTaskArtifactExport({ ...params, artifactId: 'result',
        expectedSha256: digest(content), expectedTotalBytes: limits.exportedFileBytes + 2,
      })).rejects.toThrow('Invalid Pilot artifact attestation');
      expect(reads).toHaveLength(0);
    } finally { catalog.release(); }
  });

  it('attests and re-reads the 2 MiB boundary with the catalog retained below 32 MiB', async () => {
    const content = 'x'.repeat(limits.exportedFileBytes);
    const [entry] = seed([artifact('result', 'child', content)]);
    files.set(entry!.path, content);
    let retained = 0; let peak = 0;
    const budget = { reserve(bytes: number) {
      retained += bytes; peak = Math.max(peak, retained);
      return () => { retained -= bytes; };
    } };
    const catalog = await listPilotTaskArtifactExports({ ...params, budget });
    try {
      expect(catalog.entries[0]).toMatchObject({ sha256: digest(content), totalBytes: limits.exportedFileBytes, contentState: 'available' });
      const source = await readPilotTaskArtifactExport({ ...captureParams(catalog.entries[0]!), budget });
      try { expect(source.bytes.byteLength).toBe(limits.exportedFileBytes); }
      finally { source.release(); }
      expect(peak).toBeLessThanOrEqual(limits.aggregateBytes);
    } finally { catalog.release(); }
    expect(retained).toBe(0);
  });

  it('accepts the metadata byte boundary and rejects one UTF-8 byte more', async () => {
    seed();
    const raw = JSON.parse(files.get(indexPath)!);
    raw.artifacts[0].summary = 'é';
    const text = JSON.stringify(raw);
    const padding = limits.metadataBytes - new TextEncoder().encode(text).length;
    files.set(indexPath, text + ' '.repeat(padding));
    const catalog = await listPilotTaskArtifactExports(params); catalog.release();
    files.set(indexPath, text + ' '.repeat(padding + 1));
    await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('size limit');
  });

  it('preserves stored task aliases and inherited finalization visibility', async () => {
    // Obtain the existing runtime encoding rather than inventing an alias.
    const { toTaskRuntimeId } = await import('./durableIdentity');
    const runtimeId = toTaskRuntimeId({ branchName, planId: plan.id, nodeId: 'parent' });
    seed([artifact('result', runtimeId, 'Bonjour é\n'), artifact('own', 'child', 'Bonjour é\n')]);
    const catalog = await listPilotTaskArtifactExports({ ...params, task: { ...task,
      id: 'plan-finalization-plan-1', task_source: 'plan_finalization', dependencies: ['child'] } });
    try {
      expect(catalog.entries).toHaveLength(2);
      expect(catalog.entries.every((entry) => entry.artifact.visibility === 'inherited')).toBe(true);
    } finally { catalog.release(); }
  });


  it('refuses a concurrent allocation before native IPC when another read owns its working reservation', async () => {
    seed();
    let resume!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    let checks = 0;
    const first = listPilotTaskArtifactExports({ ...params, beforeRead: async () => {
      checks += 1;
      if (checks === 2) { reached(); await blocked; }
    } });
    await entered;
    try {
      await expect(listPilotTaskArtifactExports(params)).rejects.toThrow('budget exceeded');
      expect(reads).toHaveLength(0);
    } finally { resume(); }
    const catalog = await first; catalog.release();
    const again = await listPilotTaskArtifactExports(params); again.release();
  });

  it('rejects the FNV collision when the source changes during the final content read', async () => {
    const before = 'audit-2b7a8c568e923c6dc256';
    const after = 'audit-ee22858f3f5118aaaf53';
    const [entry] = seed([artifact('result', 'child', before)]);
    files.set(entry!.path, before);
    const catalog = await listPilotTaskArtifactExports(params);
    try {
      hook = (path) => { if (path === entry!.path) files.set(path, after); };
      await expect(readPilotTaskArtifactExport(captureParams(catalog.entries[0]!))).rejects.toThrow('attestation changed');
    } finally { catalog.release(); }
  });

  it('checks a change occurring on the final native read despite an unchanged native revision', async () => {
    seed(); const catalog = await listPilotTaskArtifactExports(params);
    try {
      hook = (path) => { if (path.endsWith('result.txt')) files.set(path, 'Updated content'); };
      await expect(readPilotTaskArtifactExport(captureParams(catalog.entries[0]!))).rejects.toThrow('does not match');
    } finally { catalog.release(); }
  });
});


const planPath = `branches/${branchName}/plans/${plan.id}/plan.json`;
const planFixture = (overrides: Partial<ArchitectPlanRecord> = {}): ArchitectPlanRecord => ({
  id: plan.id, slug: 'plan-1', title: 'Plan', description: '', status: 'draft', targetBranch: branchName,
  projectIds: ['project-0'], createdAt: '2026-01-01', updatedAt: '2026-01-01',
  nodes: [{ id: 'child', title: 'Child', type: 'task', status: 'pending', dependencies: [], projectIds: ['project-0'] }],
  predictedBranches: [], ...overrides,
});

describe('Pilot bounded plan snapshot', () => {
  it('loads a valid fixture sequentially through existing scopes without historical replica reads', async () => {
    files.set(planPath, JSON.stringify(planFixture()));
    const snapshot = await readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id });
    try {
      expect(snapshot.plan).toMatchObject({ id: plan.id, status: 'draft', projectIds: ['project-0'],
        availableProjectIds: ['project-0'], missingProjectIds: [], replicationState: 'healthy' });
      expect(snapshot.plan?.nodes.map((node) => node.id)).toEqual(['child']);
      expect(reads.map((read) => read.workspaceScope)).toEqual(['direct', 'metadata_existing']);
      expect(commands.every((command) => command === 'fs_exists' || command === 'fs_read_file')).toBe(true);
    } finally { snapshot.release(); snapshot.release(); }
  });

  it('holds at most 2 MiB of plan metadata while artifact content is re-read', async () => {
    files.set(planPath, JSON.stringify(planFixture())); seed();
    let retained = 0; let peak = 0;
    const budget = { reserve(bytes: number) {
      retained += bytes; peak = Math.max(peak, retained);
      return () => { retained -= bytes; };
    } };
    const snapshot = await readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id, budget });
    try {
      expect(retained).toBeLessThanOrEqual(2 * limits.metadataBytes);
      const catalog = await listPilotTaskArtifactExports({ ...params, plan: snapshot.plan!, budget });
      try {
        const source = await readPilotTaskArtifactExport({ ...captureParams(catalog.entries[0]!), plan: snapshot.plan!, budget });
        source.release();
      } finally { catalog.release(); }
      expect(peak).toBeLessThanOrEqual(limits.aggregateBytes);
    } finally { snapshot.release(); }
    expect(retained).toBe(0);
  });

  it('passes 1 MiB to an injected limited native read, reserves before it and runs its guard', async () => {
    files.set(planPath, JSON.stringify(planFixture()));
    let retained = 0; let checks = 0;
    const snapshot = await readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id,
      beforeRead: async () => { checks += 1; },
      budget: { reserve(bytes) { retained += bytes; return () => { retained -= bytes; }; } },
      readFileLimited: async (input) => {
        expect(input.maxBytes).toBe(limits.metadataBytes);
        expect(input.allowOutsideWorkspace).toBe(false);
        expect(retained).toBeGreaterThanOrEqual(10 * limits.metadataBytes);
        expect(checks).toBeGreaterThan(0);
        return { content: files.get(input.path)! };
      },
    });
    snapshot.release();
    expect(retained).toBe(0);
    expect(reads).toHaveLength(0);
  });

  it('rejects oversized, corrupt and misidentified plan metadata without reading artifacts', async () => {
    files.set(planPath, ' '.repeat(limits.metadataBytes + 1));
    await expect(readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id })).rejects.toThrow('size limit');
    files.set(planPath, '{broken');
    await expect(readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id })).rejects.toThrow();
    files.set(planPath, JSON.stringify(planFixture({ id: 'other-plan' })));
    await expect(readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id })).rejects.toThrow('Invalid or oversized');
    expect(reads.every((read) => read.path === planPath)).toBe(true);
    await expect(readPilotTaskArtifactPlanSnapshot({ branchName, planId: '../../private' })).rejects.toThrow('identifier');
  });

  it('caps registered replicas before native discovery and aborts an expired guard', async () => {
    register(33);
    await expect(readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id })).rejects.toThrow('bounded registered');
    expect(reads).toHaveLength(0);
    register(1); files.set(planPath, JSON.stringify(planFixture()));
    await expect(readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id,
      beforeRead: async () => { throw new Error('Fixed deadline expired.'); },
    })).rejects.toThrow('Fixed deadline expired');
    expect(reads).toHaveLength(0);
    const ok = await readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id }); ok.release();
  });

  it('compares 24 plans without retaining a replica array and rejects semantic divergence', async () => {
    register(24);
    files.set(planPath, JSON.stringify(planFixture({ projectIds: plan.projectIds })));
    const snapshot = await readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id });
    try {
      expect(snapshot.plan?.replicas).toHaveLength(24);
      expect(reads).toHaveLength(48);
    } finally { snapshot.release(); }
    files.set(`/synthetic/project-23::${planPath}`, JSON.stringify(planFixture({ projectIds: plan.projectIds, title: 'Changed' })));
    await expect(readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id })).rejects.toThrow('replicas diverge');
  });

  it('discovers a persisted direct plan and applies manifest context and revision normalization', async () => {
    const direct = planFixture({ executionModesByProjectId: { 'project-0': 'direct' } });
    files.set(planPath, JSON.stringify(direct));
    files.set(manifestPath, JSON.stringify({ revision: 4.8, contextProjectIds: [], artifacts: undefined }));
    const snapshot = await readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id });
    try {
      expect(snapshot.plan).toMatchObject({ revision: 4, executionModesByProjectId: { 'project-0': 'direct' } });
      expect(reads.every((read) => read.workspaceScope === 'direct')).toBe(true);
    } finally { snapshot.release(); }
  });

  it('rejects oversized and divergent manifests while preserving empty and missing-project snapshots', async () => {
    const empty = await readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id });
    expect(empty.plan).toBeNull(); empty.release();
    register(2);
    files.set(planPath, JSON.stringify(planFixture({ projectIds: plan.projectIds })));
    files.set(manifestPath, ' '.repeat(limits.metadataBytes + 1));
    await expect(readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id })).rejects.toThrow('size limit');
    const artifacts = { count: 0, indexHash: 'one', contentHash: 'one', updatedAt: '2026-01-01' };
    files.set(manifestPath, JSON.stringify({ artifacts }));
    files.set(`/synthetic/project-1::${manifestPath}`, JSON.stringify({ artifacts: { ...artifacts, indexHash: 'two' } }));
    await expect(readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id })).rejects.toThrow('replicas diverge');
    files.clear();
    files.set(`/synthetic/project-0::${planPath}`, JSON.stringify(planFixture({ projectIds: plan.projectIds })));
    const missing = await readPilotTaskArtifactPlanSnapshot({ branchName, planId: plan.id });
    try { expect(missing.plan).toMatchObject({ missingProjectIds: ['project-1'], replicationState: 'missing_projects' }); }
    finally { missing.release(); }
  });
});
