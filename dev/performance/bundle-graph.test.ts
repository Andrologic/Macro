import { expect, test } from 'bun:test';
import { bundleGraph } from './bundle-graph.mjs';

test('static closure deduplicates cycles and excludes deferred code', () => {
  const chunk = (fileName: string, imports: string[], dynamicImports: string[] = []) => ({
    type: 'chunk', fileName, imports, dynamicImports, isEntry: fileName === 'entry.js',
    code: '123', modules: {},
  });
  const graph = bundleGraph({
    entry: chunk('entry.js', ['a.js', 'b.js'], ['lazy.js']),
    a: chunk('a.js', ['b.js']), b: chunk('b.js', ['a.js']), lazy: chunk('lazy.js', []),
  }, '/synthetic');
  expect(graph.entries[0].staticClosure).toEqual(['a.js', 'b.js', 'entry.js']);
  expect(graph.entries[0].bytes).toBe(9);
  expect(() => bundleGraph({ entry: chunk('entry.js', ['missing.js']) }, '/synthetic')).toThrow();
});
