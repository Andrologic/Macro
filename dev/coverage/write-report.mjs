import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  filterCoverageSources,
  isProductionCoverageSource,
  mergeLcovReports,
  normalizeSourcePath,
  parseLcov,
  serializeLcov,
  summarizeCoverage,
} from './lcov.mjs';

export function coveragePaths(repositoryRoot) {
  const root = path.resolve(repositoryRoot, 'coverage');
  return {
    root,
    tests: path.join(root, 'tests'),
    lcov: path.join(root, 'lcov.info'),
    summary: path.join(root, 'summary.json'),
  };
}

function assertCoverageRoot(repositoryRoot, coverageRoot) {
  const expected = path.resolve(repositoryRoot, 'coverage');
  if (path.resolve(coverageRoot) !== expected) {
    throw new Error(`Refusing to modify coverage output outside "${expected}".`);
  }
}

export async function prepareCoverageRun(repositoryRoot) {
  const paths = coveragePaths(repositoryRoot);
  assertCoverageRoot(repositoryRoot, paths.root);
  await rm(paths.tests, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  for (const artifact of [paths.lcov, paths.summary, `${paths.lcov}.tmp`, `${paths.summary}.tmp`]) {
    await rm(artifact, { force: true });
  }
  await mkdir(paths.tests, { recursive: true });
  return paths;
}

export async function collectCoverageReports(testsDirectory) {
  let entries = [];
  try {
    entries = await readdir(testsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const reports = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    const reportPath = path.join(testsDirectory, entry.name, 'lcov.info');
    try {
      const text = await readFile(reportPath, 'utf8');
      if (!text.trim()) throw new Error(`${reportPath}: coverage report is empty.`);
      reports.push({ path: reportPath, text, records: parseLcov(text, reportPath) });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return reports;
}

export async function discoverProductionSources(repositoryRoot) {
  const sources = [];
  const visit = async (directory) => {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
        const relative = path.relative(repositoryRoot, entryPath).replaceAll('\\', '/');
        if (isProductionCoverageSource(relative)) sources.push(relative);
      }
    }
  };
  await visit(path.join(repositoryRoot, 'src'));
  await visit(path.join(repositoryRoot, 'copilot-bridge', 'src'));
  return sources.sort();
}

const RETRYABLE_FILE_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES']);

async function retryTransientFileOperation(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 4 || !RETRYABLE_FILE_ERRORS.has(error?.code)) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

async function replaceFile(destination, content) {
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await retryTransientFileOperation(() => rm(destination, { force: true }));
  await retryTransientFileOperation(() => rename(temporary, destination));
}

export async function writeCoverageArtifacts({
  repositoryRoot,
  selectedTestFiles,
  availableTestFiles = selectedTestFiles.length,
  completedTestFiles,
  failedTestFiles,
  coverageDirectoryFor,
}) {
  const paths = coveragePaths(repositoryRoot);
  assertCoverageRoot(repositoryRoot, paths.root);
  const reports = await collectCoverageReports(paths.tests);
  const reportDirectories = new Set(reports.map((report) => path.basename(path.dirname(report.path))));
  const reportsMissing = selectedTestFiles.filter((file) => {
    const expectedDirectory = coverageDirectoryFor(paths.tests, file);
    return !reportDirectories.has(path.basename(expectedDirectory));
  });
  const coverage = mergeLcovReports(reports, repositoryRoot);
  const productionCoverage = filterCoverageSources(coverage);
  const discoveredSources = await discoverProductionSources(repositoryRoot);
  const canonicalDiscoveredSources = discoveredSources.map((source) => normalizeSourcePath(source, repositoryRoot).path);
  const summary = summarizeCoverage(coverage, {
    partial: failedTestFiles.length > 0 || reportsMissing.length > 0,
    testFilesSelected: selectedTestFiles.length,
    testFilesAvailable: availableTestFiles,
    testFilesCompleted: completedTestFiles,
    testFilesFailed: failedTestFiles,
    reportsFound: reports.length,
    reportsMissing,
    productionFilesDiscovered: canonicalDiscoveredSources,
  });
  await mkdir(paths.root, { recursive: true });
  await replaceFile(paths.lcov, serializeLcov(productionCoverage));
  await replaceFile(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
  return { paths, summary };
}

export function formatCoverageSummary(summary) {
  const lineSummary = summary.totals.lines;
  const coverage = lineSummary.percent == null ? 'n/a' : `${lineSummary.percent.toFixed(2)}%`;
  const suffix = summary.partial ? ' (partial)' : '';
  const lines = [
    `Coverage${suffix}: ${coverage} application lines (${lineSummary.hit ?? 0}/${lineSummary.found ?? 0}).`,
    `Instrumented application files: ${summary.instrumentedFiles}/${summary.productionFilesDiscovered}.`,
    `Reports: ${summary.reportsFound}/${summary.testFilesSelected}.`,
  ];
  if (summary.testFilesSelected < summary.testFilesAvailable) {
    lines.push(`Filtered run: ${summary.testFilesSelected}/${summary.testFilesAvailable} test files selected; uninstrumented files reflect this subset.`);
  }
  return lines.join('\n');
}
