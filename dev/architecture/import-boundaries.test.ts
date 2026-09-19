import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveConfig } from 'vite';
import { dirname, join, relative } from 'node:path';
import {
  analyzeSources,
  compareReports,
  EXPLICITLY_FORBIDDEN_EDGES,
} from './import-boundaries.mjs';

const fixtureRoot = join(import.meta.dir, 'fixtures');

function edge(report: ReturnType<typeof analyzeSources>, from: string, to: string) {
  const result = report.edges.find((candidate) => candidate.from === from && candidate.to === to);
  expect(result).toBeDefined();
  return result!;
}

describe('TypeScript import boundary analysis', () => {
  it('uses TSX-aware transpilation and preserves type/runtime import kinds', () => {
    const sources = {
      'src/fixture.tsx': readFileSync(join(fixtureRoot, 'tsx-import-fixture.tsx'), 'utf8'),
      'src/type-model.ts': readFileSync(join(fixtureRoot, 'type-model.ts'), 'utf8'),
      'src/runtime-renderer.ts': readFileSync(join(fixtureRoot, 'runtime-renderer.ts'), 'utf8'),
      'src/unmarked-type.ts': "import { Model } from './type-model'; export const id = (model: Model) => model.id;\n",
      'src/js-mapping.ts': "import { Model } from './type-model.js'; export const id = (model: Model) => model.id;\n",
      'src/lazy.ts': "export const load = () => import('./runtime-renderer');\n",
      'src/side-effect.ts': 'export const loaded = true;\n',
    };
    const report = analyzeSources(sources);

    expect(report.diagnostics).toEqual([]);
    expect(edge(report, 'src/fixture.tsx', 'src/type-model.ts').kinds).toEqual(['type']);
    expect(edge(report, 'src/fixture.tsx', 'src/runtime-renderer.ts').kinds).toEqual(['runtime', 'type']);
    expect(edge(report, 'src/unmarked-type.ts', 'src/type-model.ts').kinds).toEqual(['type']);
    expect(edge(report, 'src/js-mapping.ts', 'src/type-model.ts').kinds).toEqual(['type']);
    expect(edge(report, 'src/fixture.tsx', 'src/side-effect.ts').kinds).toEqual(['runtime']);
    expect(edge(report, 'src/lazy.ts', 'src/runtime-renderer.ts')).toMatchObject({ kinds: ['runtime'], lazy: true });
  });

  it('detects a newly added forbidden service edge while retaining the baseline exception', () => {
    const baseline = analyzeSources({
      'src/services/existing.ts': 'import { useStore } from "../stores/store"; export const value = useStore;\n',
      'src/stores/store.ts': 'export const useStore = {};\n',
    }, 'base');
    const current = analyzeSources({
      'src/services/existing.ts': 'import { useStore } from "../stores/store"; import { useOtherStore } from "../stores/other"; export const value = [useStore, useOtherStore];\n',
      'src/stores/store.ts': 'export const useStore = {};\n',
      'src/stores/other.ts': 'export const useOtherStore = {};\n',
    });

    const comparison = compareReports({ ...baseline, baseRef: 'base', exceptions: baseline.exceptions }, current);
    expect(comparison.newForbiddenEdges).toEqual([
      expect.objectContaining({ from: 'src/services/existing.ts', to: 'src/stores/other.ts', kind: 'runtime' }),
    ]);
    expect(comparison.passed).toBe(false);
  });

  it('detects a new runtime SCC and includes model type imports in boundary violations', () => {
    const baseline = analyzeSources({
      'src/types/model.ts': 'export type Model = { id: string };\n',
      'src/services/one.ts': 'export const one = 1;\n',
      'src/services/two.ts': 'export const two = 2;\n',
    }, 'base');
    const current = analyzeSources({
      'src/types/model.ts': 'import type { StoreState } from "../stores/store"; export type Model = StoreState;\n',
      'src/stores/store.ts': 'export type StoreState = { id: string };\n',
      'src/services/one.ts': 'import { two } from "./two"; export const one = two;\n',
      'src/services/two.ts': 'import { one } from "./one"; export const two = one;\n',
    });

    const comparison = compareReports({ ...baseline, baseRef: 'base', exceptions: baseline.exceptions }, current);
    expect(current.violations).toEqual([
      expect.objectContaining({ rule: 'models-to-application', kind: 'type', from: 'src/types/model.ts', to: 'src/stores/store.ts' }),
    ]);
    expect(comparison.newSccs).toEqual([['src/services/one.ts', 'src/services/two.ts']]);
    expect(comparison.passed).toBe(false);
  });

  it('guards model ImportTypeNode references', () => {
    const report = analyzeSources({
      'src/types/import-type-model.ts': "export type Model = import('../stores/store').Store;\n",
      'src/stores/store.ts': 'export type Store = { id: string };\n',
    });

    expect(report.edges).toEqual([
      expect.objectContaining({
        from: 'src/types/import-type-model.ts',
        to: 'src/stores/store.ts',
        kinds: ['type'],
      }),
    ]);
    expect(report.violations).toEqual([
      expect.objectContaining({ rule: 'models-to-application', kind: 'type' }),
    ]);
  });

  it('rejects non-literal dynamic imports and require calls', () => {
    const report = analyzeSources({
      'src/unsupported.ts': "const moduleName = './module'; import(moduleName); require(moduleName);\n",
      'src/module.ts': 'export const value = 1;\n',
    });

    expect(report.diagnostics).toEqual([
      expect.objectContaining({ message: 'Unsupported non-literal dynamic import at line 1.' }),
      expect.objectContaining({ message: 'Unsupported non-literal require at line 1.' }),
    ]);
  });

  it('resolves baseUrl source-root imports and diagnoses missing local targets', () => {
    const report = analyzeSources({
      'src/services/new.ts': 'import { state } from "src/stores/store"; export const value = state;',
      'src/types/model.ts': 'export type State = import("src/stores/store").State;',
      'src/services/missing.ts': 'import "src/stores/missing";',
      'src/stores/store.ts': 'export const state = 1; export type State = number;',
    });
    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/services/new.ts', to: 'src/stores/store.ts', kind: 'runtime' }),
      expect.objectContaining({ from: 'src/types/model.ts', to: 'src/stores/store.ts', kind: 'type' }),
    ]));
    expect(report.unresolved).toEqual([
      expect.objectContaining({ from: 'src/services/missing.ts', specifier: 'src/stores/missing' }),
    ]);
    expect(compareReports(analyzeSources({}), report).passed).toBe(false);
  });

  it('includes dynamic import options in forbidden edges and cycle detection', () => {
    const report = analyzeSources({
      'src/services/a.ts': 'export const load = () => import("../stores/b", {});',
      'src/stores/b.ts': 'export const load = () => import("../services/a", {});',
    });
    expect(report.diagnostics).toEqual([]);
    expect(report.violations).toEqual([
      expect.objectContaining({ from: 'src/services/a.ts', to: 'src/stores/b.ts', kind: 'runtime' }),
    ]);
    const comparison = compareReports(analyzeSources({}), report);
    expect(comparison.newSccs).toEqual([['src/services/a.ts', 'src/stores/b.ts']]);
    expect(comparison.passed).toBe(false);
  });

  it('resolves configured Vite aliases and root paths for boundaries and cycles', () => {
    for (const specifier of ['@stores/store', '@/stores/store', '/src/stores/store', '@stores/store?module']) {
      const report = analyzeSources({
        'src/services/new.ts': `import "${specifier}";`,
        'src/stores/store.ts': 'import "../services/new"; export const state = 1;',
      });
      expect(report.violations).toEqual([
        expect.objectContaining({ from: 'src/services/new.ts', to: 'src/stores/store.ts', kind: 'runtime' }),
      ]);
      const comparison = compareReports(analyzeSources({}), report);
      expect(comparison.newSccs).toEqual([['src/services/new.ts', 'src/stores/store.ts']]);
      expect(comparison.passed).toBe(false);
    }
  });

  it('reads alias additions from configuration and diagnoses unresolved alias targets', () => {
    const report = analyzeSources({
      'vite.config.ts': 'export default { resolve: { alias: { "@state": "/src/stores" } } };',
      'src/types/model.ts': 'export type State = import("@state/store").State;',
      'src/services/new.ts': 'import "@state/missing";',
      'src/stores/store.ts': 'export type State = number;',
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ from: 'src/types/model.ts', to: 'src/stores/store.ts', kind: 'type' }),
    ]);
    expect(report.unresolved).toEqual([
      expect.objectContaining({ from: 'src/services/new.ts', specifier: '@state/missing' }),
    ]);
    expect(() => analyzeSources({
      'vite.config.ts': 'export default { resolve: { alias: getAliases() } };',
    })).toThrow('literal Vite alias object');
  });

  it('preserves explicit extensions and prefers .ts over .tsx for extensionless imports', () => {
    const report = analyzeSources({
      'src/services/new.ts': 'import "../stores/store";',
      'src/services/explicit.ts': 'import "../stores/store.tsx";',
      'src/stores/store.ts': 'import "../services/new"; export const state = 1;',
      'src/stores/store.tsx': 'export const state = 2;',
    });
    expect(edge(report, 'src/services/new.ts', 'src/stores/store.ts').kinds).toEqual(['runtime']);
    expect(edge(report, 'src/services/explicit.ts', 'src/stores/store.tsx').kinds).toEqual(['runtime']);
    expect(report.sccs).toEqual([['src/services/new.ts', 'src/stores/store.ts']]);
  });

  it('fails closed for shorthand, spreads and indirect Vite resolution configuration', () => {
    const configurations = [
      'const alias = { "@stores": "/src/stores" }; export default { resolve: { alias } };',
      'const resolve = { alias: {} }; export default { resolve };',
      'export default { resolve: { ...shared, alias: {} } };',
      'export default { resolve: { alias: {} }, ...other };',
      'export default { resolve: { [key]: {} } };',
      'const unused = { alias: {} }; export default externalConfiguration;',
      'export default defineConfig(() => flag ? first : second);',
      'export default { root: "other", resolve: { alias: {} } };',
      'export default { resolve: { alias: {}, extensions: [".tsx", ".ts"] } };',
    ];
    for (const configuration of configurations) {
      expect(() => analyzeSources({
        'vite.config.ts': configuration,
        'src/services/new.ts': 'import "@stores/store";',
        'src/stores/store.ts': 'import "../services/new";',
      })).toThrow('Import guard');
    }
  });

  it('keeps the four planned removals explicit and blocking', () => {
    const sources = Object.fromEntries(EXPLICITLY_FORBIDDEN_EDGES.map(({ from, to }) => [
      from,
      `import value from './${relative(dirname(from), to).replace(/\.(?:ts|tsx)$/, '')}'; export default value;\n`,
    ]));
    const graphSources = {
      ...sources,
    };
    for (const { to } of EXPLICITLY_FORBIDDEN_EDGES) graphSources[to] ??= 'export default {};\n';
    const report = analyzeSources(graphSources);

    expect(report.explicitForbiddenEdges.map(({ id }) => id)).toEqual(EXPLICITLY_FORBIDDEN_EDGES.map(({ id }) => id));
  });

  it('allows a legitimate reduction of a baseline SCC but rejects a new cycle inside old members', () => {
    const baseline = analyzeSources({
      'src/a.ts': 'import { b } from "./b"; import { c } from "./c"; export const a = [b, c];\n',
      'src/b.ts': 'import { a } from "./a"; import { c } from "./c"; export const b = [a, c];\n',
      'src/c.ts': 'import { a } from "./a"; export const c = a;\n',
    }, 'base');
    const reduced = analyzeSources({
      'src/a.ts': 'import { b } from "./b"; export const a = b;\n',
      'src/b.ts': 'import { a } from "./a"; export const b = a;\n',
      'src/c.ts': 'export const c = 1;\n',
    });
    expect(compareReports({ ...baseline, baseRef: 'base' }, reduced).newSccs).toEqual([]);

    const cycleBaseline = analyzeSources({
      'src/a.ts': 'import { c } from "./c"; export const a = c;\n',
      'src/b.ts': 'import { a } from "./a"; export const b = a;\n',
      'src/c.ts': 'import { b } from "./b"; export const c = b;\n',
    }, 'base');
    const newCycle = analyzeSources({
      'src/a.ts': 'import { b } from "./b"; export const a = b;\n',
      'src/b.ts': 'import { a } from "./a"; export const b = a;\n',
      'src/c.ts': 'export const c = 1;\n',
    });
    expect(compareReports({ ...cycleBaseline, baseRef: 'base' }, newCycle).newSccs).toEqual([['src/a.ts', 'src/b.ts']]);
  });
});

// This resolver loads Vite itself, never Macro's config, plugins, env files or server.
async function withViteFixture(
  files: Record<string, string>,
  alias: Record<string, string>,
  check: (resolveId: (specifier: string) => Promise<string | undefined>, root: string) => Promise<void>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'macro-import-resolution-')));
  try {
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    const config = await resolveConfig({ root, configFile: false, envFile: false, plugins: [], resolve: { alias } }, 'serve');
    const resolveId = config.createResolver();
    await check(async (specifier) => {
      const resolved = await resolveId(specifier, join(root, 'src/services/entry.ts'));
      return resolved ? relative(root, resolved.split(/[?#]/, 1)[0]) : undefined;
    }, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function aliasConfig(alias: Record<string, string>) {
  return `export default { resolve: { alias: ${JSON.stringify(alias)} } };`;
}

describe('installed Vite resolution contract', () => {
  it('matches slash normalization, first-match order, root and relative replacements', async () => {
    const cases: Array<{ alias: Record<string, string>; specifier: string; target: string }> = [
      { alias: { '@stores/': '/src/stores/' }, specifier: '@stores/store', target: 'src/stores/store.ts' },
      { alias: { '@stores/': '/src/stores/' }, specifier: '@stores', target: 'src/stores/index.ts' },
      { alias: { '@stores': '/src/stores/' }, specifier: '@stores/store', target: 'src/stores/store.ts' },
      { alias: { '@stores/': '/src/stores' }, specifier: '@stores//store', target: 'src/stores/store.ts' },
      { alias: { '@': '/src', '@/stores': '/src/other' }, specifier: '@/stores/store', target: 'src/stores/store.ts' },
      { alias: { '@/stores': '/src/other', '@': '/src' }, specifier: '@/stores/store', target: 'src/other/store.ts' },
      { alias: { '@stores': '../stores' }, specifier: '@stores/store', target: 'src/stores/store.ts' },
      { alias: { '@stores': './nested' }, specifier: '@stores/store', target: 'src/services/nested/store.ts' },
      { alias: {}, specifier: '/src/stores/store', target: 'src/stores/store.ts' },
      { alias: { '@stores': '/src/stores' }, specifier: '@stores/store?module', target: 'src/stores/store.ts' },
    ];
    for (const { alias, specifier, target } of cases) {
      const files = {
        'src/services/entry.ts': `import ${JSON.stringify(specifier)};`,
        'src/stores/store.ts': 'import "../services/entry";',
        'src/stores/index.ts': 'export {};',
        'src/other/store.ts': 'export {};',
        'src/services/nested/store.ts': 'export {};',
      };
      await withViteFixture(files, alias, async (resolveId) => {
        expect(await resolveId(specifier)).toBe(target);
        const report = analyzeSources({ ...files, 'vite.config.ts': aliasConfig(alias) });
        expect(report.diagnostics).toEqual([]);
        expect(report.unresolved).toEqual([]);
        edge(report, 'src/services/entry.ts', target);
        if (target === 'src/stores/store.ts') {
          expect(report.sccs).toContainEqual(['src/services/entry.ts', target]);
          expect(compareReports(analyzeSources({}), report).passed).toBe(false);
        }
      });
    }
  });

  it('does not fall through to a later alias when the first target is missing', async () => {
    const alias = { '@': '/src/missing', '@/stores': '/src/stores' };
    const files = { 'src/services/entry.ts': 'import "@/stores/store";', 'src/stores/store.ts': 'export {};' };
    await withViteFixture(files, alias, async (resolveId) => {
      expect(await resolveId('@/stores/store')).not.toBe('src/stores/store.ts');
      const report = analyzeSources({ ...files, 'vite.config.ts': aliasConfig(alias) });
      expect(report.edges).toEqual([]);
      expect(report.unresolved).toHaveLength(1);
      expect(compareReports(analyzeSources({}), report).passed).toBe(false);
    });
  });

  it('matches exact files, JS-output remapping, extension precedence and directory index', async () => {
    const cases = [
      { request: 'store', targets: ['store.ts', 'store.tsx'], expected: 'store.ts' },
      { request: 'store.tsx', targets: ['store.ts', 'store.tsx'], expected: 'store.tsx' },
      { request: 'store.js', targets: ['store.ts', 'store.tsx', 'store.js.ts'], expected: 'store.ts' },
      { request: 'store.js', targets: ['store.tsx', 'store.js.ts'], expected: 'store.tsx' },
      { request: 'store.jsx', targets: ['store.ts', 'store.tsx'], expected: 'store.tsx' },
      { request: 'store.js', targets: ['store.js.ts'], expected: 'store.js.ts' },
      { request: 'store.mjs', targets: ['store.ts', 'store.mjs.ts'], expected: 'store.mjs.ts' },
      { request: 'store.cjs', targets: ['store.ts', 'store.cjs.ts'], expected: 'store.cjs.ts' },
      { request: 'store', targets: ['store/index.ts', 'store/index.tsx'], expected: 'store/index.ts' },
      { request: 'store', targets: ['store.tsx', 'store/index.ts'], expected: 'store.tsx' },
    ];
    for (const { request, targets, expected } of cases) {
      const specifier = `../stores/${request}`;
      const files = Object.fromEntries(targets.map((target) => [`src/stores/${target}`, 'export {};']));
      files['src/services/entry.ts'] = `import ${JSON.stringify(specifier)};`;
      await withViteFixture(files, {}, async (resolveId) => {
        expect(await resolveId(specifier)).toBe(`src/stores/${expected}`);
        const report = analyzeSources({ ...files, 'vite.config.ts': aliasConfig({}) });
        expect(report.diagnostics).toEqual([]);
        expect(report.unresolved).toEqual([]);
        edge(report, 'src/services/entry.ts', `src/stores/${expected}`);
      });
    }
  });

  it('blocks unsupported targets that would otherwise shadow an analyzed source file', async () => {
    for (const [request, target] of [['store', 'store.js'], ['store', 'store.mts'], ['store.js', 'store.js'], ['store.mjs', 'store.mts'], ['store.cjs', 'store.cts']]) {
      const files = {
        'src/services/entry.ts': `import "../stores/${request}";`,
        'src/stores/store.ts': 'export {};',
        [`src/stores/${target}`]: 'export {};',
      };
      await withViteFixture(files, {}, async (resolveId) => {
        expect(await resolveId(`../stores/${request}`)).toBe(`src/stores/${target}`);
        const report = analyzeSources({ ...files, 'vite.config.ts': aliasConfig({}) });
        expect(report.diagnostics).toEqual([expect.objectContaining({ message: expect.stringContaining('unsupported source module') })]);
        expect(compareReports(analyzeSources({}), report).passed).toBe(false);
      });
    }
  });

  it('rejects filesystem and bare alias replacements and unsupported resolution options', async () => {
    const files = { 'src/services/entry.ts': 'import "@stores/store";', 'src/stores/store.ts': 'export {};' };
    await withViteFixture(files, {}, async (_resolveId, root) => {
      const alias = { '@stores': join(root, 'src/stores') };
      const config = await resolveConfig({ root, configFile: false, envFile: false, plugins: [], resolve: { alias } }, 'serve');
      expect(await config.createResolver()('@stores/store', join(root, 'src/services/entry.ts'))).toBe(join(root, 'src/stores/store.ts'));
      expect(() => analyzeSources({ ...files, 'vite.config.ts': aliasConfig(alias) })).toThrow('unsupported alias name or replacement');
    });
    for (const replacement of ['src/stores', '/absolute/src/stores', '/src/$&', '/src/stores?query', 'some-package']) {
      expect(() => analyzeSources({ 'vite.config.ts': aliasConfig({ '@stores': replacement }) })).toThrow('Import guard');
    }
    for (const option of ['extensions: [".tsx", ".ts"]', 'preserveSymlinks: true', 'mainFields: ["main"]']) {
      expect(() => analyzeSources({ 'vite.config.ts': `export default { resolve: { alias: {}, ${option} } };` })).toThrow('additional Vite resolution options');
    }
  });

  it('blocks package entry resolution and relative imports that escape the source tree', () => {
    const report = analyzeSources({
      'vite.config.ts': aliasConfig({ '@outside': '../../outside' }),
      'src/services/entry.ts': 'import "../stores"; import "@outside/module";',
      'src/stores/package.json': '{"main":"actual.ts"}',
      'src/stores/actual.ts': 'export {};',
      'src/stores/index.ts': 'export {};',
    });
    expect(report.diagnostics).toHaveLength(2);
    expect(compareReports(analyzeSources({}), report).passed).toBe(false);
  });
});
