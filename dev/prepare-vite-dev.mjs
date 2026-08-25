import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const viteCacheDir = resolve(root, 'node_modules/.vite');
const viteMetadataPath = resolve(viteCacheDir, 'deps/_metadata.json');
const macroCacheStatePath = resolve(viteCacheDir, 'macro-cache-state.json');
const cacheStateVersion = 1;
const cacheInputs = [
  'bun.lock',
  'bun.lockb',
  'package.json',
  'vite.config.ts',
].map((path) => ({
  label: path,
  path: resolve(root, path),
}));

const getMtimeMs = async (path) => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
};

const removeViteCache = async (reason) => {
  await rm(viteCacheDir, { recursive: true, force: true });
  console.log(`[dev] Cleared Vite dependency cache (${reason}).`);
};

const readCacheInput = async ({ label, path }) => {
  try {
    return `${label}\0${await readFile(path, 'utf8')}`;
  } catch {
    return `${label}\0<missing>`;
  }
};

const createCacheSignature = async () => {
  const hash = createHash('sha256');
  hash.update(`macro-vite-cache-state:${cacheStateVersion}\0`);

  for (const input of cacheInputs) {
    hash.update(await readCacheInput(input));
    hash.update('\0');
  }

  return hash.digest('hex');
};

const readMacroCacheState = async () => {
  try {
    return JSON.parse(await readFile(macroCacheStatePath, 'utf8'));
  } catch {
    return null;
  }
};

const writeMacroCacheState = async (signature) => {
  await mkdir(viteCacheDir, { recursive: true });
  await writeFile(
    macroCacheStatePath,
    `${JSON.stringify({ version: cacheStateVersion, signature }, null, 2)}\n`,
    'utf8',
  );
};

const getNewestCacheInput = async (metadataMtime) => {
  for (const input of cacheInputs) {
    const inputMtime = await getMtimeMs(input.path);
    if (inputMtime !== null && inputMtime > metadataMtime) {
      return input.label;
    }
  }

  return null;
};

const signature = await createCacheSignature();

if (process.env.MACRO_VITE_CLEAN_CACHE === '1') {
  await removeViteCache('forced');
  await writeMacroCacheState(signature);
  process.exit(0);
}

const metadataMtime = await getMtimeMs(viteMetadataPath);
const cacheState = await readMacroCacheState();
if (
  metadataMtime !== null &&
  cacheState?.version === cacheStateVersion &&
  cacheState.signature === signature
) {
  process.exit(0);
}

if (metadataMtime !== null) {
  const newestInput = await getNewestCacheInput(metadataMtime);
  await removeViteCache(
    newestInput
      ? `${newestInput} is newer than optimized deps`
      : 'dependency cache signature changed',
  );
}

await writeMacroCacheState(signature);
