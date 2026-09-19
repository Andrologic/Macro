import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
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
