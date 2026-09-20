import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const [assets, sourceSha] = process.argv.slice(2);
if (!assets || !/^[a-f0-9]{40}$/.test(sourceSha ?? '')) {
  throw new Error('Usage: bun dev/performance/bundles.ts <fresh-build/assets> <source SHA>');
}
const files = readdirSync(assets).filter((name) => /\.(js|css)$/.test(name)).sort();
if (!files.some((name) => /^index-.*\.js$/.test(name))) throw new Error('Missing built entry chunk');
const rows = files.map((name) => {
  const data = readFileSync(join(assets, name));
  return { name, bytes: data.byteLength, gzipBytes: gzipSync(data, { level: 9 }).byteLength,
    sha256: createHash('sha256').update(data).digest('hex') };
});
console.log(JSON.stringify({ sourceSha, provenance: 'Caller attests fresh build of sourceSha; build directory is not verified',
  bun: Bun.version, unit: 'bytes', gzipLevel: 9, rows,
  total: rows.reduce((sum, row) => sum + row.bytes, 0),
  totalGzip: rows.reduce((sum, row) => sum + row.gzipBytes, 0),
  caveat: 'All emitted JS/CSS, not initial load. Excludes fonts, maps, native binaries and HTTP headers.' }, null, 2));
