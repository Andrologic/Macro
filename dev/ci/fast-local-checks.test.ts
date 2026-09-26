import { describe, expect, test } from 'bun:test';
import {
  normalizePaths,
  planFastLocalChecks,
  relativeImports,
  selectLintFiles,
  selectRelatedTestFiles,
} from './fast-local-checks.mjs';

describe('fast local check selection', () => {
  test('normalizes and deduplicates changed paths', () => {
    expect(normalizePaths(['src\\b.ts', './src/a.ts', 'src/a.ts'])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('lints only existing JavaScript and TypeScript files', () => {
    expect(selectLintFiles(
      ['src/kept.tsx', 'dev/check.mjs', 'src/deleted.ts', 'src/style.css'],
      (path) => path !== 'src/deleted.ts',
    )).toEqual(['dev/check.mjs', 'src/kept.tsx']);
  });

  test('selects changed tests, sibling tests, and direct importers', () => {
    const files = new Set([
      'src/a.ts',
      'src/a.test.ts',
      'src/feature.test.tsx',
      'src/unrelated.test.ts',
    ]);
    const contents = new Map([
      ['src/feature.test.tsx', "import { a } from './a';"],
      ['src/unrelated.test.ts', "import { b } from './b';"],
    ]);
    expect(selectRelatedTestFiles({
      changedPaths: ['src/a.ts', 'src/feature.test.tsx', 'src/deleted.test.ts'],
      testFiles: [...files, 'src/deleted.test.ts'],
      exists: (path) => files.has(path),
      readFile: (path) => contents.get(path) || '',
    })).toEqual(['src/a.test.ts', 'src/feature.test.tsx']);
  });

  test('matches index modules imported through their directory', () => {
    expect(selectRelatedTestFiles({
      changedPaths: ['src/domain/index.ts'],
      testFiles: ['src/consumer.test.ts'],
      readFile: () => "export { value } from './domain';",
    })).toEqual(['src/consumer.test.ts']);
  });

  test('extracts static imports, exports, side effects, and dynamic imports', () => {
    expect(relativeImports(`
      import './setup';
      import { value } from './value';
      export { other } from './other';
      const lazy = import('./lazy');
    `)).toEqual(['./setup', './value', './other', './lazy']);
  });

  test('keeps documentation pushes minimal', () => {
    const plan = planFastLocalChecks(['docs/ci.md']);
    expect(plan.steps.map((step) => step.name)).toEqual([
      'Versions cohérentes',
      'Binaires suivis autorisés',
    ]);
  });

  test('adds only checks associated with changed areas', () => {
    const files = new Set(['src/i18n/fr.ts', 'src/i18n/fr.test.ts', 'src-tauri/src/main.rs']);
    const plan = planFastLocalChecks(
      ['src/i18n/fr.ts', 'src-tauri/src/main.rs', '.github/workflows/ci.yml'],
      {
        exists: (path) => files.has(path) || path === '.github/workflows/ci.yml',
        testFiles: ['src/i18n/fr.test.ts'],
        readFile: () => '',
      },
    );
    expect(plan.steps.map((step) => step.name)).toEqual([
      'Versions cohérentes',
      'Binaires suivis autorisés',
      'Workflows GitHub valides',
      'Traductions cohérentes',
      'Frontières des domaines',
      'ESLint ciblé (1 fichier)',
      'Tests liés (1 fichier)',
      'Formatage Rust',
      'Préparer le sidecar pour les contrats natifs',
      'Contrats générés config',
      'Contrats générés ipc',
    ]);
  });

  test('checks dependency manifests and local GitHub actions without installing', () => {
    const plan = planFastLocalChecks(['bun.lock', 'bunfig.toml', '.github/actions/setup/action.yml']);
    expect(plan.steps.map((step) => step.name)).toEqual([
      'Versions cohérentes',
      'Binaires suivis autorisés',
      'Verrouillage des dépendances cohérent',
      'Workflows GitHub valides',
      'Types du bridge Copilot',
    ]);
    expect(plan.steps[2]).toMatchObject({
      args: ['install', '--frozen-lockfile', '--lockfile-only', '--dry-run'],
      quiet: true,
    });
  });
  test('checks import boundaries when resolution inputs change', () => {
    for (const path of ['vite.config.ts', 'package.json', 'src/nested/package.json', 'src/stores/store.js', 'src/stores/store.mts']) {
      const plan = planFastLocalChecks([path]);
      expect(plan.steps).toContainEqual(expect.objectContaining({
        args: ['dev/architecture/import-boundaries.mjs', '--check'],
      }));
    }
  });

  test('routes extracted native modules to the boundary guard even when deleted', () => {
    for (const path of [
      'src-tauri/src/core/command_error.rs', 'src-tauri/src/core/db_state.rs',
      'src-tauri/src/core/mcp_ids.rs', 'src-tauri/src/core/workspace_execution/nested/tool.rs',
      'src-tauri/src/fs/operations.rs', 'src-tauri/src/fs/mutation_locks.rs',
      'src-tauri/src/git/operations.rs', 'src-tauri/src/git/operations/workflow.rs',
    ]) {
      const plan = planFastLocalChecks([path], { exists: () => false });
      const guards = plan.steps.filter((step) => step.args.includes('dev/architecture/import-boundaries.mjs'));
      expect(guards).toHaveLength(1);
      expect(guards[0]).toMatchObject({ args: ['dev/architecture/import-boundaries.mjs', '--check'], needsDependencies: true });
    }
    const unrelated = planFastLocalChecks(['src-tauri/src/core/diagnostics.rs']);
    expect(unrelated.steps.some((step) => step.args.includes('dev/architecture/import-boundaries.mjs'))).toBe(false);
  });

  test('typechecks changed Copilot code, configuration and imported dependencies once', () => {
    const paths = [
      'copilot-bridge/src/protocol.ts', 'copilot-bridge/src/protocol.test.ts',
      'copilot-bridge/tsconfig.json', 'src/shared/macroToolRegistry.ts', 'src/shared/toolOutputLimits.ts',
      'src/types/generated/ipc/BridgeToolResultMessage.ts',
      'src-tauri/src/ai/copilot/fixtures/tool-results.json',
      'package.json', 'bun.lock', 'bunfig.toml', 'dev/ci/check-profiles.mjs',
    ];
    for (const changed of [...paths.map((path) => [path]), paths]) {
      const plan = planFastLocalChecks(changed, { exists: () => false });
      const checks = plan.steps.filter((step) => step.args.includes('typecheck:copilot'));
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ command: process.execPath, args: ['run', 'typecheck:copilot'], needsDependencies: true });
    }
    for (const path of ['README.md', 'src/components/Panel.tsx', 'src-tauri/src/git/operations.rs']) {
      expect(planFastLocalChecks([path]).steps.some((step) => step.args.includes('typecheck:copilot'))).toBe(false);
    }
  });

});


test('checks generated contracts for dependencies, generator helpers, and removed artifacts', () => {
  for (const path of [
    'src-tauri/src/db/models.rs', 'src-tauri/src/any/dependency.rs',
    'src-tauri/examples/generate_config/register_ipc.rs',
    'src-tauri/examples/generate_config/fixtures/Root.ts.fixture',
    'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
    'src/types/generated/ipc/serde_json/JsonValue.ts',
    'src/types/generated/config/ConfigScope.ts',
    'src-tauri/config-schemas/v1/workspace.schema.json',
    'package.json', 'dev/ci/check-profiles.mjs',
  ]) {
    const plan = planFastLocalChecks([path], { exists: () => false });
    const checks = plan.steps.filter((entry) => entry.args.includes('generate_config'));
    expect(checks).toHaveLength(2);
    expect(checks.map((entry) => entry.args.at(-2))).toEqual(['config', 'ipc']);
    expect(checks.every((entry) => entry.args.includes('--check'))).toBe(true);
    expect(checks.every((entry) => entry.args.includes('--locked'))).toBe(true);
  }
  for (const path of ['src/components/Panel.tsx', 'README.md']) {
    expect(planFastLocalChecks([path]).steps.some((entry) => entry.args.includes('generate_config'))).toBe(false);
  }
});


test('selects CI policy tests when JavaScript gate implementations change', () => {
  const tests = ['dev/ci/fast-local-checks.test.ts', 'dev/ci/check-profiles.test.ts', 'dev/ci/importer.test.ts'];
  expect(selectRelatedTestFiles({
    changedPaths: ['dev/ci/fast-local-checks.mjs', 'dev/ci/check-profiles.mjs'],
    testFiles: tests,
    readFile: () => "import { stepsForProfile } from './check-profiles.mjs';",
  })).toEqual(['dev/ci/check-profiles.test.ts', 'dev/ci/fast-local-checks.test.ts', 'dev/ci/importer.test.ts']);
});
