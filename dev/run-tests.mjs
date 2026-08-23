#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import os from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  formatCoverageSummary,
  prepareCoverageRun,
  writeCoverageArtifacts,
} from './coverage/write-report.mjs';
import { formatDuration } from './format-duration.mjs';

const TEST_EXTENSIONS = ['.test.ts', '.test.tsx'];

export const IGNORED_PREFIXES = Object.freeze([
  'node_modules/',
  'src-tauri/',
  'dist/',
  '.worktrees/',
  '.git/',
  'coverage/',
]);

const productionConditionTestFiles = new Set([
  'src/components/chat/composer/ComposerEditor.test.tsx',
]);
const testTimeoutMs = 30_000;

export function normalizePath(file) {
  return file.replace(/^\.\//, '').replaceAll('\\', '/');
}

export function isIgnoredPath(normalized) {
  return IGNORED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isTestPath(normalized) {
  return TEST_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

export function selectTestFiles(paths) {
  const files = new Set();
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (isIgnoredPath(normalized) || !isTestPath(normalized)) {
      continue;
    }
    files.add(normalized);
  }
  return Array.from(files).sort();
}

export async function collectTestFiles() {
  const paths = [];
  for (const extension of TEST_EXTENSIONS) {
    const glob = new Bun.Glob(`**/*${extension}`);
    for await (const file of glob.scan('.')) {
      paths.push(file);
    }
  }
  return selectTestFiles(paths);
}

export function usesProductionConditions(file) {
  return productionConditionTestFiles.has(normalizePath(file));
}

export function coverageDirectoryFor(rootDirectory, file) {
  const normalized = normalizePath(file);
  const slug = normalized
    .replace(/\.test\.tsx?$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${rootDirectory.replace(/[\\/]+$/, '')}/${slug}-${digest}`;
}

export function spawnArgsForFile(file, options = {}) {
  const args = [];
  if (usesProductionConditions(file)) {
    // Bun 1.3.14 creates an initialization cycle in Lexical's development ESM
    // exports. Keep React in test mode while selecting Lexical's equivalent
    // production exports for the affected integration test.
    args.push('--conditions=production');
  }
  args.push('test');
  args.push(`--timeout=${testTimeoutMs}`);
  if (options.coverage) {
    // The text reporter only prints to stdout; lcov is what persists per-file
    // reports under --coverage-dir on bun 1.3.14.
    args.push('--coverage', '--coverage-reporter=lcov');
    args.push(`--coverage-dir=${coverageDirectoryFor(options.coverageDirectory || 'coverage/tests', file)}`);
  }
  args.push(normalizePath(file));
  return args;
}

export function resolveConcurrency(requested) {
  const available = os.availableParallelism?.() ?? os.cpus().length;
  const fallback = Math.max(1, Math.min(available - 1, 6));
  if (requested === undefined) {
    return fallback;
  }
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`Invalid test concurrency "${requested}". Use an integer >= 1.`);
  }
  return requested;
}

export function resolveConfiguredConcurrency(cliValue, environmentValue) {
  if (cliValue !== undefined) {
    return resolveConcurrency(cliValue);
  }
  if (environmentValue !== undefined && environmentValue !== '') {
    return resolveConcurrency(Number(environmentValue));
  }
  return resolveConcurrency();
}

export function parseRunOptions(argv) {
  const options = { filters: [], concurrency: undefined, coverage: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    }
    if (argument === '--coverage') {
      options.coverage = true;
    } else if (argument === '--list') {
      options.list = true;
    } else if (argument.startsWith('--concurrency=')) {
      options.concurrency = resolveConcurrency(Number(argument.slice('--concurrency='.length)));
    } else if (argument === '--concurrency') {
      index += 1;
      options.concurrency = resolveConcurrency(Number(argv[index]));
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option "${argument}". Supported: --concurrency=<n>, --coverage, --list.`);
    } else {
      options.filters.push(argument);
    }
  }
  return options;
}

export function filterFiles(files, filters) {
  if (filters.length === 0) {
    return files;
  }
  const lowercaseFilters = filters.map((filter) => filter.toLowerCase());
  return files.filter((file) => lowercaseFilters.some((filter) => file.toLowerCase().includes(filter)));
}

export async function runWithConcurrency(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid worker limit "${limit}". Use an integer >= 1.`);
  }
  const results = new Array(items.length);
  let cursor = 0;
  let stopped = false;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!stopped && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function drain(stream) {
  if (!stream) {
    return '';
  }
  return await new Response(stream).text();
}

const activeProcesses = new Set();

function stopActiveProcesses(signal = 'SIGTERM') {
  for (const proc of activeProcesses) {
    try {
      proc.kill(signal);
    } catch {
      // The process may already have exited between iteration and kill.
    }
  }
}

async function runTestFile(file, options) {
  const startedAt = Date.now();
  const args = spawnArgsForFile(file, options).map((argument) => (
    argument.startsWith('--coverage-dir=')
      ? `--coverage-dir=${resolve(argument.slice('--coverage-dir='.length))}`
      : argument
  ));
  const proc = Bun.spawn(['bun', ...args], {
    env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  activeProcesses.add(proc);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([drain(proc.stdout), drain(proc.stderr), proc.exited]);
    return {
      file,
      exitCode,
      durationMs: Date.now() - startedAt,
      output: exitCode === 0 ? '' : `${stdout}${stderr}`.trimEnd(),
    };
  } finally {
    activeProcesses.delete(proc);
  }
}

function reportProgress(result, completed, total) {
  const status = result.exitCode === 0 ? 'ok  ' : 'FAIL';
  console.log(`[${completed}/${total}] ${status} ${formatDuration(result.durationMs)}  ${result.file}`);
}

function reportFailures(failures) {
  console.error(`\n${failures.length} test file(s) failed:`);
  for (const failure of failures) {
    console.error(`\n--- ${failure.file} ---`);
    if (failure.output) {
      console.error(failure.output);
    }
  }
}

async function main() {
  const repositoryRoot = resolve('.');
  const options = parseRunOptions(process.argv.slice(2));
  const allFiles = await collectTestFiles();
  const files = filterFiles(allFiles, options.filters);

  if (files.length === 0) {
    console.error(options.filters.length > 0
      ? `No test file matches: ${options.filters.join(', ')}`
      : 'No test files found.');
    process.exit(1);
  }
  if (options.list) {
    files.forEach((file) => console.log(file));
    return;
  }

  const concurrency = resolveConfiguredConcurrency(
    options.concurrency,
    process.env.MACRO_TEST_CONCURRENCY,
  );
  if (options.coverage) {
    await prepareCoverageRun(repositoryRoot);
  }
  console.log(`Running ${files.length} test file(s) with concurrency ${concurrency}${options.coverage ? ' (coverage on)' : ''}.`);
  const startedAt = Date.now();

  let completed = 0;
  const interrupt = () => {
    stopActiveProcesses('SIGTERM');
    process.exit(130);
  };
  const terminate = () => {
    stopActiveProcesses('SIGTERM');
    process.exit(143);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);

  let results;
  try {
    results = await runWithConcurrency(files, concurrency, async (file) => {
      const result = await runTestFile(file, options);
      completed += 1;
      reportProgress(result, completed, files.length);
      return result;
    });
  } catch (error) {
    stopActiveProcesses();
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }

  const failures = results.filter((result) => result.exitCode !== 0);
  let coverageError = null;
  if (options.coverage) {
    try {
      const { summary } = await writeCoverageArtifacts({
        repositoryRoot,
        selectedTestFiles: files,
        availableTestFiles: allFiles.length,
        completedTestFiles: completed,
        failedTestFiles: failures.map((failure) => failure.file),
        coverageDirectoryFor,
      });
      console.log(`\n${formatCoverageSummary(summary)}`);
      console.log('Coverage artifacts: coverage/lcov.info and coverage/summary.json');
    } catch (error) {
      coverageError = error;
      console.error(`\nCoverage aggregation failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (failures.length > 0) {
    reportFailures(failures);
  }
  if (failures.length > 0 || coverageError) {
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll ${files.length} test file(s) passed in ${formatDuration(Date.now() - startedAt)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
