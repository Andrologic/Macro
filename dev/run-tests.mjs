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
    env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  return exitCode;
};

const collectTestFiles = async () => {
  const files = new Set();

  for (const pattern of testGlobs) {
    const glob = new Bun.Glob(pattern);
    for await (const file of glob.scan('.')) {
      const normalized = file.replace(/^\.\//, '').replaceAll('\\', '/');
      if (ignoredPrefixes.some((prefix) => normalized.startsWith(prefix))) {
        continue;
      }
      files.add(normalized);
    }
  }

  return Array.from(files).sort();
};

const testFiles = await collectTestFiles();

const failedFiles = [];
for (const file of testFiles) {
  const exitCode = await run([file]);
  if (exitCode !== 0) {
    failedFiles.push(file);
  }
}

if (failedFiles.length > 0) {
  console.error(`\n${failedFiles.length} test file(s) failed:`);
  failedFiles.forEach((file) => console.error(`- ${file}`));
  process.exit(1);
}
