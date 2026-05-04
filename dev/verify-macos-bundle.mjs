import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const targetRoot = resolve(root, 'src-tauri', 'target');
const appleSiliconBundleRoot = join(
  targetRoot,
  'aarch64-apple-darwin',
  'release',
  'bundle',
  'macos'
);

const parseAppPath = () => {
  const appFlagIndex = process.argv.indexOf('--app');
  if (appFlagIndex !== -1) {
    return process.argv[appFlagIndex + 1];
  }
  return process.env.MACRO_APP_PATH || process.argv.slice(2).find((arg) => !arg.startsWith('--'));
};

const run = async (command, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: root });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : ''}`);
  }
};

const assertExists = async (path, label) => {
  try {
    await access(path, constants.F_OK);
  } catch {
    throw new Error(`${label} missing: ${path}`);
  }
};

const assertExecutable = async (path, label) => {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${path}`);
  }
};

const findLatestApp = async () => {
  await assertExists(
    appleSiliconBundleRoot,
    'Apple Silicon macOS bundle directory. Run `bun run tauri:build:dmg:mac-arm64:test` first'
  );
  const output = await run('find', [
    appleSiliconBundleRoot,
    '-maxdepth',
    '1',
    '-name',
    '*.app',
    '-type',
    'd',
    '-print',
  ]);
  const apps = output.split('\n').filter(Boolean);
  if (apps.length === 0) {
    throw new Error(`No Apple Silicon macOS .app bundle found under ${appleSiliconBundleRoot}`);
  }

  const appStats = await Promise.all(
    apps.map(async (appPath) => ({
      appPath,
      mtimeMs: (await stat(appPath)).mtimeMs,
    }))
  );
  appStats.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return appStats[0].appPath;
};

const assertArm64Binary = async (path, label) => {
  const output = await run('lipo', ['-info', path]);
  if (!/\barm64\b/.test(output)) {
    throw new Error(`${label} is not arm64. lipo output: ${output}`);
  }
  console.log(`OK ${label}: ${output}`);
};

const findMainExecutable = async (macosDir) => {
  const preferred = join(macosDir, 'macro');
  try {
    await access(preferred, constants.X_OK);
    return preferred;
  } catch {
    // Fall through to executable discovery.
  }

  const entries = await readdir(macosDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === 'macro-ai-runtime') {
      continue;
    }
    const candidate = join(macosDir, entry.name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  throw new Error(`No executable app binary found in ${macosDir}`);
};

const verifyManifest = async (manifestPath) => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest?.runtimes?.['macos-arm64']) {
    throw new Error(`${manifestPath} does not contain runtimes.macos-arm64`);
  }
  console.log(`OK Copilot runtime manifest includes macos-arm64: ${manifestPath}`);
};

const appPath = resolve(root, parseAppPath() || (await findLatestApp()));
const resourcesDir = join(appPath, 'Contents', 'Resources');
const macosDir = join(appPath, 'Contents', 'MacOS');
const manifestPath = join(resourcesDir, 'copilot-runtime-manifest.json');
const licensePath = join(resourcesDir, 'licenses', 'github-copilot-cli-LICENSE.md');
const runtimePath = join(macosDir, 'macro-ai-runtime');
const mainExecutablePath = await findMainExecutable(macosDir);

await assertExists(appPath, 'macOS app bundle');
await assertExists(manifestPath, 'Copilot runtime manifest');
await verifyManifest(manifestPath);
await assertExists(licensePath, 'Copilot runtime license');
await assertExecutable(runtimePath, 'Macro AI runtime sidecar');
await assertArm64Binary(runtimePath, 'Macro AI runtime sidecar');
await assertArm64Binary(mainExecutablePath, 'Macro app executable');
await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

console.log(`OK codesign verification passed: ${appPath}`);
