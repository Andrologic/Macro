import { expect, test } from 'bun:test';
import { bundleGraph, deferredStartupViolations } from './bundle-graph.mjs';

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

test('startup check catches both terminal CSS coupling and shared Mermaid helpers', () => {
  const graph = { entries: [{ name: 'entry.js', staticClosure: ['entry.js'] }],
    chunks: [{ name: 'entry.js', modules: [{ id: 'src/main.tsx' }] },
      { name: 'terminal.js', modules: [{ id: 'node_modules/xterm/lib/xterm.js' }] },
      { name: 'diagram.js', modules: [{ id: 'node_modules/mermaid/dist/mermaid.core.mjs' }] },
      { name: 'chat.js', modules: [{ id: 'src/services/streamingChatExecution.ts' }] }]  };
  expect(deferredStartupViolations(graph)).toEqual([]);
  graph.entries[0].staticClosure.push('terminal.js', 'diagram.js', 'chat.js');
  expect(deferredStartupViolations(graph).map(issue => issue.chunk)).toEqual(['terminal.js', 'diagram.js', 'chat.js']);
});
