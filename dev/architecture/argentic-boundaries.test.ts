import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argenticCounts, compareArgentic, isArgenticFile, tightenArgentic } from './extracted-boundaries.mjs';
import { analyzeSources } from './import-boundaries.mjs';

const baseRef = '627ea641d8ab1439ca41e9cd68bb07454ea33c49';
const file = 'src-tauri/src/agsdl_host_flow030.rs';
const empty = () => ({ schemaVersion: 1, baseRef, counts: { rust: {}, imports: {} } });
const counts = (sources: Record<string, string>) => analyzeSources(sources).argentic;

describe('Argentic boundaries', () => {
  it('covers mapped and future files without covering Macro-only adapters', () => {
    for (const path of [file, 'src-tauri/src/ai/stream_tasks.rs', 'src-tauri/src/core/process.rs', 'src-tauri/src/fs/operations.rs', 'src-tauri/src/commands/mcp/agsdl_raw.rs', 'src-tauri/src/db/exact_json.rs', 'src-tauri/src/agsdl_permissions/mod.rs', 'src-tauri/src/argentic_core/nested/new.rs', 'src-tauri/src/argentic_runtime/new.rs', 'crates/argentic-core/src/new.rs', 'crates/argentic-runtime/src/new.rs']) expect(isArgenticFile(path)).toBe(true);
    for (const path of ['src-tauri/src/agsdl_host_capture.rs', 'src-tauri/src/agsdl_host_catalogue.rs', 'src-tauri/src/db/agsdl_execution/intents.rs', 'src-tauri/src/commands/agsdl_execution.rs', 'src-tauri/src/core/diagnostics.rs']) expect(isArgenticFile(path)).toBe(false);
  });

  it('guards the shared filesystem reader through the real CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'argentic-filesystem-'));
    const shared = 'src-tauri/src/fs/operations.rs';
    try {
      mkdirSync(join(root, 'src-tauri/src/fs'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(root, 'vite.config.ts'), 'export default { resolve: { alias: {} } };');
      writeFileSync(join(root, 'graph.json'), JSON.stringify(analyzeSources({})));
      writeFileSync(join(root, 'argentic.json'), JSON.stringify(empty()));
      const cli = () => Bun.spawnSync([process.execPath, join(import.meta.dir, 'import-boundaries.mjs'),
        '--root', root, '--baseline', 'graph.json', '--argentic-baseline', 'argentic.json', '--format', 'json', '--check']);
      writeFileSync(join(root, shared), 'pub fn workspace_root_identity() {}');
      expect(cli().exitCode).toBe(0);
      for (const [source, rule] of [
        ['pub fn workspace_root_identity(_config: &crate::config::ConfigManager) {}', 'crate:config'],
        ['pub fn workspace_root_identity(_db: &crate::db::DbState) {}', 'crate:db'],
        ['use sqlx::SqlitePool;', 'token:sqlx'],
      ]) {
        writeFileSync(join(root, shared), source);
        const result = cli();
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout.toString()).comparison.argenticIssues).toEqual([
          expect.objectContaining({ file: shared, rule, count: 1, limit: 0, direction: 'increase' }),
        ]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('counts grouped and qualified roots and rejects new couplings and floating point in pure modules', () => {
    const current = counts({ [file]: 'use crate::{db as database, commands::{self as cmd}}; crate::db::open();', 'crates/argentic-core/src/new.rs': 'let n = s.parse::<f64>(); value.as_f64();' });
    expect(current.rust[file]).toEqual({ 'crate:commands': 1, 'crate:db': 2 });
    expect(current.rust['crates/argentic-core/src/new.rs']).toEqual({ 'pure:as_f64': 1, 'pure:f64': 1 });
    expect(compareArgentic(empty(), current)).toHaveLength(4);
    expect(compareArgentic(empty(), counts({ [file]: 'use serde::Serialize;' }))).toEqual([]);
  });

  it('tightens a decrease without allowing later reintroduction or a new file', () => {
    const original = { ...empty(), counts: counts({ [file]: 'tauri::x(); tauri::y();' }) };
    const reduced = counts({ [file]: 'tauri::x();' });
    expect(compareArgentic(original, reduced)[0]).toMatchObject({ direction: 'decrease', count: 1, limit: 2 });
    const tightened = tightenArgentic(original, reduced);
    expect(compareArgentic(tightened, reduced)).toEqual([]);
    expect(compareArgentic(tightened, counts({ [file]: 'tauri::x(); tauri::y();', 'crates/argentic-runtime/src/lib.rs': 'use sqlx::Pool;' })).map((v: { direction: string }) => v.direction)).toEqual(['increase', 'increase']);
  });

  it('guards runtime and type importers through the existing graph', () => {
    const target = 'src/services/agsdlExecution/hostCompilation.ts';
    const original = counts({ [target]: 'export type Port = {}; export const run = 1;', 'src/existing.ts': "import { run } from './services/agsdlExecution/hostCompilation'; export { run };" });
    const changed = counts({ [target]: 'export type Port = {}; export const run = 1;', 'src/existing.ts': "import { run } from './services/agsdlExecution/hostCompilation'; export { run };", 'src/new.ts': "import type { Port } from './services/agsdlExecution/hostCompilation'; export type P = Port;" });
    expect(compareArgentic({ ...empty(), counts: original }, changed)).toContainEqual(expect.objectContaining({ file: 'src/new.ts', rule: `import:type:${target}`, direction: 'increase' }));
  });

  it('fails closed in the real CLI and only tightens existing limits', () => {
    const root = mkdtempSync(join(tmpdir(), 'argentic-boundary-'));
    try {
      mkdirSync(join(root, 'src-tauri/src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(root, 'vite.config.ts'), 'export default { resolve: { alias: {} } };');
      writeFileSync(join(root, 'graph.json'), JSON.stringify(analyzeSources({})));
      const path = join(root, file);
      const baseline = { ...empty(), counts: counts({ [file]: 'tauri::x(); tauri::y();' }) };
      writeFileSync(join(root, 'argentic.json'), JSON.stringify(baseline));
      writeFileSync(path, 'tauri::x();');
      const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, 'import-boundaries.mjs'), '--root', root, '--baseline', 'graph.json', '--argentic-baseline', 'argentic.json', ...args]);
      expect(cli('--check').exitCode).toBe(1);
      expect(cli('--tighten-argentic').exitCode).toBe(0);
      expect(cli('--check').exitCode).toBe(0);
      writeFileSync(path, 'tauri::x(); tauri::y(); sqlx::Pool;');
      expect(cli('--tighten-argentic').exitCode).toBe(1);
      expect(JSON.parse(readFileSync(join(root, 'argentic.json'), 'utf8')).counts.rust[file]).toEqual({ 'token:tauri': 1 });
      expect(cli('--check').exitCode).toBe(1);
      writeFileSync(join(root, 'argentic.json'), '{');
      expect(cli('--check').stderr.toString()).toContain('Invalid Argentic baseline');
      rmSync(join(root, 'argentic.json'));
      expect(cli('--check').stderr.toString()).toContain('Argentic baseline not found');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
