import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const targetRoot = resolve(root, 'src-tauri', 'target');
const TARGET_ARCHITECTURES = {
  'aarch64-apple-darwin': ['arm64'],
  'x86_64-apple-darwin': ['x86_64'],
  'universal-apple-darwin': ['arm64', 'x86_64'],
};

const parseOptions = () => {
  const options = {
    appPath: process.env.MACRO_APP_PATH || null,
    target: process.env.MACRO_BUNDLE_TARGET || 'aarch64-apple-darwin',
  };

  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === '--app') {
      options.appPath = process.argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--app=')) {
      options.appPath = arg.slice('--app='.length);
      continue;
    }
    if (arg === '--target') {
      options.target = process.argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length);
      continue;
    }
  }

  return options;
};

const bundleRootForTarget = (target) => join(targetRoot, target, 'release', 'bundle', 'macos');

const targetLabel = (target) => {
  if (target === 'universal-apple-darwin') {
    return 'Universal macOS';
  }
  if (target === 'aarch64-apple-darwin') {
    return 'Apple Silicon macOS';
  }
  if (target === 'x86_64-apple-darwin') {
    return 'Intel macOS';
  }
  return target;
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

const findLatestApp = async (target) => {
  const bundleRoot = bundleRootForTarget(target);
  await assertExists(
    bundleRoot,
    `${targetLabel(target)} bundle directory. Run the matching macOS Tauri build first`
  );
  const output = await run('find', [
    bundleRoot,
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
    throw new Error(`No ${targetLabel(target)} .app bundle found under ${bundleRoot}`);
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

const assertBinaryArchitectures = async (path, label, architectures) => {
  const output = await run('lipo', ['-info', path]);
  for (const architecture of architectures) {
    const pattern = new RegExp(`\\b${architecture}\\b`);
    if (!pattern.test(output)) {
      throw new Error(`${label} is missing ${architecture}. lipo output: ${output}`);
    }
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

const verifyManifest = async (manifestPath, architectures) => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const requiredRuntimeKeys = architectures.map((architecture) =>
    architecture === 'x86_64' ? 'macos-x64' : 'macos-arm64'
  );
  for (const runtimeKey of requiredRuntimeKeys) {
    if (!manifest?.runtimes?.[runtimeKey]) {
      throw new Error(`${manifestPath} does not contain runtimes.${runtimeKey}`);
    }
  }
  console.log(`OK Copilot runtime manifest includes ${requiredRuntimeKeys.join(', ')}: ${manifestPath}`);
};

const options = parseOptions();
const architectures = TARGET_ARCHITECTURES[options.target];
if (!architectures) {
  throw new Error(
    `Unsupported macOS bundle target "${options.target}". Supported targets: ${Object.keys(TARGET_ARCHITECTURES).join(', ')}.`
  );
}

const appPath = resolve(root, options.appPath || (await findLatestApp(options.target)));
const resourcesDir = join(appPath, 'Contents', 'Resources');
const macosDir = join(appPath, 'Contents', 'MacOS');
const manifestPath = join(resourcesDir, 'copilot-runtime-manifest.json');
const licensePath = join(resourcesDir, 'licenses', 'github-copilot-cli-LICENSE.md');
const runtimePath = join(macosDir, 'macro-ai-runtime');
const mainExecutablePath = await findMainExecutable(macosDir);

await assertExists(appPath, 'macOS app bundle');
await assertExists(manifestPath, 'Copilot runtime manifest');
await verifyManifest(manifestPath, architectures);
await assertExists(licensePath, 'Copilot runtime license');
await assertExecutable(runtimePath, 'Macro AI runtime sidecar');
await assertBinaryArchitectures(runtimePath, 'Macro AI runtime sidecar', architectures);
await assertBinaryArchitectures(mainExecutablePath, 'Macro app executable', architectures);
await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

console.log(`OK codesign verification passed: ${appPath}`);
