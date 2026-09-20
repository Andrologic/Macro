import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_RUNTIME_ENTRIES } from './extracted-boundaries.mjs';
import { analyzeSources, compareReports } from './import-boundaries.mjs';

const entry = 'src/services/chatStreamOrchestrator.ts';
const baseline = analyzeSources({});

describe('extracted Chat runtime boundaries', () => {
  it('rejects UI packages at every delivered entry while permitting type imports', () => {
    for (const from of CHAT_RUNTIME_ENTRIES) {
      for (const specifier of ['react', 'react/jsx-runtime', 'react-dom/client', 'zustand/vanilla']) {
        const runtime = analyzeSources({ [from]: `import '${specifier}';` });
        expect(runtime.extractedBoundaries.chat).toContainEqual(expect.objectContaining({ from, to: specifier }));
        // Even a newly generated baseline cannot grandfather this boundary.
        expect(compareReports(runtime, runtime).passed).toBe(false);
        const types = analyzeSources({ [from]: `import type { Model } from '${specifier}'; export type Port = Model;` });
        expect(compareReports(baseline, types).passed).toBe(true);
      }
    }
  });

  it('follows lazy imports and barrel exports, stops at type edges, and reports the path', () => {
    const sources = {
      [entry]: "export const load = () => import('./helper');",
      'src/services/helper.ts': "export * from './barrel'; import './chatStreamOrchestrator';",
      'src/services/barrel.ts': "export { create } from 'zustand';",
    };
    const runtime = analyzeSources(sources);
    expect(runtime.extractedBoundaries.chat).toEqual([expect.objectContaining({
      rule: 'chat-runtime-to-ui-package', entry, from: 'src/services/barrel.ts', to: 'zustand',
      path: [entry, 'src/services/helper.ts', 'src/services/barrel.ts', 'zustand'],
    })]);
    const types = analyzeSources({ ...sources, [entry]: "export type Port = import('./helper').Port;" });
    expect(types.extractedBoundaries.chat).toEqual([]);
  });

  it('rejects direct concrete adapters through resolved aliases, but permits their contracts', () => {
    const targets = [
      'src/services/tauriIpc.ts', 'src/services/streamingChat.ts',
      'src/services/ipc/filesystem.ts', 'src/services/ipc/ai.ts', 'src/services/ipc/runtime.ts',
      'src/services/tauriRuntimeBridge.ts', 'src/services/tauriHttp.ts',
      'src/services/browserRuntimeTransport.ts', 'src/services/tauriDialog.ts', 'src/services/tauriWindow.ts',
      'src/services/providers/ipc.ts', 'src/services/providers/remote.ts',
      'src/composition/chatStreamComposition.ts',
    ];
    for (const target of targets) {
      const specifier = target.replace(/^src\//, '@/').replace(/\.ts$/, '');
      const modules = { [target]: 'export type Port = {}; export const adapter = {};' };
      const runtime = analyzeSources({ ...modules, [entry]: `export const load = () => import('${specifier}');` });
      expect(runtime.extractedBoundaries.chat).toContainEqual(expect.objectContaining({ rule: 'chat-entry-to-adapter', to: target }));
      expect(compareReports(runtime, runtime).passed).toBe(false);
      const types = analyzeSources({ ...modules, [entry]: `export type Port = import('${specifier}').Port;` });
      expect(compareReports(baseline, types).passed).toBe(true);
    }
    const nativePackage = analyzeSources({ [entry]: "import { invoke } from '@tauri-apps/api/core'; export const transport = invoke;" });
    expect(compareReports(baseline, nativePackage).passed).toBe(false);
    expect(nativePackage.extractedBoundaries.chat[0].to).toBe('@tauri-apps/api/core');
  });

  it('rejects a static domain IPC import while allowing pure contracts and adapter types', () => {
    const modules = {
      'src/services/ipc/filesystem.ts': 'export const fsReadFile = () => {};',
      'src/services/ipc/filesystem.types.ts': 'export type FsFileContentDto = { content: string };',
      'src/services/chatStreamContracts.ts': 'export type StreamPort = { stop(): void };',
    };
    const runtime = analyzeSources({
      ...modules,
      [entry]: "import { fsReadFile } from './ipc/filesystem'; export const read = fsReadFile;",
    });
    expect(runtime.extractedBoundaries.chat).toEqual([expect.objectContaining({
      rule: 'chat-entry-to-adapter', from: entry, to: 'src/services/ipc/filesystem.ts',
    })]);
    expect(compareReports(baseline, runtime).passed).toBe(false);
    const contracts = analyzeSources({
      ...modules,
      [entry]: `
        import './ipc/filesystem.types';
        import type { FsFileContentDto } from './ipc/filesystem.types';
        import type { StreamPort } from './chatStreamContracts';
        import type { fsReadFile } from './ipc/filesystem';
        export type Port = StreamPort & { read: typeof fsReadFile; content: FsFileContentDto };
      `,
    });
    expect(compareReports(baseline, contracts).passed).toBe(true);
  });

  it('detects the implicit React runtime generated by JSX in a dependency', () => {
    const report = analyzeSources({
      [entry]: "export { View } from './view';",
      'src/services/view.tsx': 'export const View = () => <span />;',
    });
    expect(report.extractedBoundaries.chat).toContainEqual(expect.objectContaining({
      entry, from: 'src/services/view.tsx', to: 'react/jsx-runtime',
    }));
    expect(compareReports(baseline, report).passed).toBe(false);
  });
});

describe('bounded native extraction guard', () => {
  it('rejects qualified paths, grouped imports, aliases and unqualified adapter types', () => {
    const from = 'src-tauri/src/core/workspace_execution/tool_output.rs';
    for (const source of [
      'use crate::commands::fs::read_file;',
      'use super::commands as adapter;',
      'use crate::{\n  commands::{self as adapter},\n};',
      'use tauri::{AppHandle as Handle, State};',
      'extern crate tauri as desktop;',
      'fn run(app: AppHandle, state: State<Db>, window: Window) {}',
      'fn run() { crate::commands::run(); }',
    ]) {
      const report = analyzeSources({ [from]: source });
      expect(report.extractedBoundaries.native.length).toBeGreaterThan(0);
      expect(report.extractedBoundaries.native[0].from).toBe(from);
      expect(compareReports(report, report).passed).toBe(false);
    }
  });

  it('covers the extracted files and descendants without policing actual adapters', () => {
    const files = [
      'core/command_error.rs', 'core/db_state.rs', 'core/mcp_ids.rs',
      'core/workspace_execution/mod.rs', 'core/workspace_execution/nested/tests.rs',
      'fs/operations.rs', 'fs/mutation_locks.rs', 'git/operations.rs',
      'git/operations/workflow.rs',
    ].map((path) => `src-tauri/src/${path}`);
    const sources = Object.fromEntries(files.map((path) => [path, 'use crate::db::DbError;']));
    sources['src-tauri/src/commands/fs.rs'] = 'use tauri::AppHandle;';
    sources['src-tauri/src/core/diagnostics.rs'] = 'use tauri::State;';
    expect(compareReports(baseline, analyzeSources(sources)).passed).toBe(true);
    const report = analyzeSources(Object.fromEntries(files.map((path) => [path, '\nuse tauri as desktop;'])));
    expect(report.extractedBoundaries.native.map(({ from }) => from).sort()).toEqual(files.sort());
    expect(report.extractedBoundaries.native.every(({ line }) => line === 2)).toBe(true);
  });

  it('makes the existing CLI check fail on a native regression', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-native-boundary-'));
    try {
      mkdirSync(join(root, 'src-tauri/src/core'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(root, 'vite.config.ts'), 'export default { resolve: { alias: {} } };');
      writeFileSync(join(root, 'baseline.json'), JSON.stringify(baseline));
      const native = join(root, 'src-tauri/src/core/db_state.rs');
      const check = () => Bun.spawnSync([process.execPath, join(import.meta.dir, 'import-boundaries.mjs'),
        '--root', root, '--baseline', 'baseline.json', '--check', '--format', 'json']);
      writeFileSync(native, 'use sqlx::SqlitePool;');
      const clean = check();
      expect({ exitCode: clean.exitCode, stderr: clean.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
      writeFileSync(native, 'use tauri::{State as DbState};');
      const failed = check();
      expect(failed.exitCode).toBe(1);
      const report = JSON.parse(failed.stdout.toString());
      expect(report.comparison.extractedBoundaryViolations).toContainEqual(expect.objectContaining({ to: 'tauri' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
