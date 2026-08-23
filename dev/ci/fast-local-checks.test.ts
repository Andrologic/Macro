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

  test('lints only existing TypeScript files', () => {
    expect(selectLintFiles(
      ['src/kept.tsx', 'src/deleted.ts', 'src/style.css'],
      (path) => path !== 'src/deleted.ts',
    )).toEqual(['src/kept.tsx']);
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
      'ESLint ciblé (1 fichier)',
      'Tests liés (1 fichier)',
      'Formatage Rust',
    ]);
  });
});
