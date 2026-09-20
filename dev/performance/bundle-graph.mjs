import { relative } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Static JS closure only. Dynamic startup imports and browser rendering are not inferred. */
export function bundleGraph(bundle, root) {
  const chunks = Object.values(bundle).filter(item => item.type === 'chunk').map(chunk => ({
    name: chunk.fileName,
    isEntry: chunk.isEntry,
    imports: chunk.imports,
    dynamicImports: chunk.dynamicImports,
    bytes: Buffer.byteLength(chunk.code),
    gzipBytes: gzipSync(chunk.code, { level: 9 }).byteLength,
    modules: Object.entries(chunk.modules).map(([id, module]) => ({
      id: relative(root, id.replace(/^\0/, '')), renderedLength: module.renderedLength,
    })).sort((a, b) => b.renderedLength - a.renderedLength),
  }));
  const byName = new Map(chunks.map(chunk => [chunk.name, chunk]));
  const entries = chunks.filter(chunk => chunk.isEntry).map(entry => {
    const seen = new Set();
    const visit = name => {
      if (seen.has(name)) return;
      const chunk = byName.get(name);
      if (!chunk) throw new Error(`Unresolved static chunk: ${name}`);
      seen.add(name);
      chunk.imports.forEach(visit);
    };
    visit(entry.name);
    const names = [...seen].sort();
    return { name: entry.name, staticClosure: names,
      bytes: names.reduce((sum, name) => sum + byName.get(name).bytes, 0),
      gzipBytes: names.reduce((sum, name) => sum + byName.get(name).gzipBytes, 0) };
  });
  return { chunks, entries, caveat: 'Emitted static JS imports; excludes CSS, runtime dynamic loads and rendering. Module renderedLength is before final minification; do not add it to emitted byte sizes.' };
}
