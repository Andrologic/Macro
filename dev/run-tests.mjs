const testGlobs = [
  '**/*.test.ts',
  '**/*.test.tsx',
];

const ignoredPrefixes = [
  'node_modules/',
  'src-tauri/',
  'dist/',
];

const run = async (args) => {
  const proc = Bun.spawn(['bun', 'test', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
};

const collectTestFiles = async () => {
  const files = new Set();

  for (const pattern of testGlobs) {
    const glob = new Bun.Glob(pattern);
    for await (const file of glob.scan('.')) {
      const normalized = file.replace(/^\.\//, '');
      if (ignoredPrefixes.some((prefix) => normalized.startsWith(prefix))) {
        continue;
      }
      files.add(normalized);
    }
  }

  return Array.from(files).sort();
};

const testFiles = await collectTestFiles();

for (const file of testFiles) {
  await run([file]);
}
