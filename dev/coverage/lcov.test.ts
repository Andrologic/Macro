import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  domainForSource,
  filterCoverageSources,
  mergeLcovReports,
  normalizeSourcePath,
  parseLcov,
  serializeLcov,
  summarizeCoverage,
} from './lcov.mjs';
import {
  collectCoverageReports,
  coveragePaths,
  prepareCoverageRun,
  writeCoverageArtifacts,
} from './write-report.mjs';

const temporaryDirectories: string[] = [];

const makeTemporaryRepository = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'macro-coverage-'));
  temporaryDirectories.push(directory);
  return directory;
};

const report = (reportPath: string, text: string) => ({
  path: reportPath,
  text,
  records: parseLcov(text, reportPath),
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('LCOV parsing and merging', () => {
  test('merges line counters exactly and recalculates summaries', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    const first = report('first.info', [
      'TN:',
      'SF:src\\stores\\chat.ts',
      'FNF:2',
      'FNH:1',
      'DA:10,2',
      'DA:20,0',
      'LF:2',
      'LH:1',
      'end_of_record',
      '',
    ].join('\n'));
    const second = report('second.info', [
      'TN:',
      'SF:./src/stores/chat.ts',
      'FNF:2',
      'FNH:1',
      'DA:10,3',
      'DA:20,4',
      'LF:2',
      'LH:2',
      'end_of_record',
      '',
    ].join('\n'));

    const merged = mergeLcovReports([first, second], repositoryRoot, 'win32');
    const serialized = serializeLcov(merged);
    expect(serialized).toContain('SF:src/stores/chat.ts');
    expect(serialized).toContain('DA:10,5');
    expect(serialized).toContain('DA:20,4');
    expect(serialized).toContain('LF:2\nLH:2');
    expect(serialized).not.toContain('FNF:');
  });

  test('produces deterministic output regardless of report order', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    const first = report('z.info', 'SF:src/z.ts\nDA:2,1\nend_of_record\n');
    const second = report('a.info', 'SF:src/a.ts\nDA:10,1\nDA:2,0\nend_of_record\n');
    expect(serializeLcov(mergeLcovReports([first, second], repositoryRoot))).toBe(
      serializeLcov(mergeLcovReports([second, first], repositoryRoot)),
    );
  });

  test('merges identified functions and branches when the reporter provides them', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    const fixture = report('identified.info', [
      'SF:src/service.ts',
      'FN:5,run',
      'FNDA:2,run',
      'FNF:1',
      'FNH:1',
      'DA:5,2',
      'BRDA:6,0,0,1',
      'BRDA:6,0,1,-',
      'BRF:2',
      'BRH:1',
      'end_of_record',
      '',
    ].join('\n'));
    const output = serializeLcov(mergeLcovReports([fixture], repositoryRoot));
    expect(output).toContain('FN:5,run\nFNDA:2,run\nFNF:1\nFNH:1');
    expect(output).toContain('BRDA:6,0,0,1\nBRDA:6,0,1,-\nBRF:2\nBRH:1');
  });

  test('sums known branch hits while preserving unknown hits from another report', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    const unknown = report('unknown.info', 'SF:src/service.ts\nBRDA:6,0,0,-\nend_of_record\n');
    const known = report('known.info', 'SF:src/service.ts\nBRDA:6,0,0,3\nend_of_record\n');
    const output = serializeLcov(mergeLcovReports([unknown, known], repositoryRoot));
    expect(output).toContain('BRDA:6,0,0,3\nBRF:1\nBRH:1');
  });

  test('rejects traversal, absolute paths, duplicates, malformed counters, and truncated records', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    expect(() => normalizeSourcePath('../outside.ts', repositoryRoot)).toThrow(/escapes/);
    expect(() => normalizeSourcePath(path.join(repositoryRoot, 'src', 'a.ts'), repositoryRoot)).toThrow(/relative/);
    expect(() => parseLcov('SF:src/a.ts\nDA:1,nope\nend_of_record\n', 'bad.info')).toThrow(/malformed DA/);
    expect(() => parseLcov('SF:src/a.ts\nDA:1,1\n', 'truncated.info')).toThrow(/missing end_of_record/);

    const duplicates = report('duplicates.info', [
      'SF:src\\A.ts',
      'DA:1,1',
      'end_of_record',
      'SF:src/a.ts',
      'DA:1,1',
      'end_of_record',
      '',
    ].join('\n'));
    expect(() => mergeLcovReports([duplicates], repositoryRoot, 'win32')).toThrow(/Duplicate normalized/);
  });

  test('keeps counters above signed 32-bit range', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    const fixture = report('large.info', 'SF:src/a.ts\nDA:1,2147483648\nend_of_record\n');
    expect(serializeLcov(mergeLcovReports([fixture], repositoryRoot))).toContain('DA:1,2147483648');
  });
});

describe('coverage summaries', () => {
  test('reports application lines by domain and marks unavailable metrics honestly', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    const fixture = report('summary.info', [
      'SF:src\\stores\\chat.ts',
      'FNF:2',
      'FNH:1',
      'DA:1,1',
      'DA:2,0',
      'end_of_record',
      'SF:src\\stores\\chat.test.ts',
      'DA:1,1',
      'end_of_record',
      'SF:test-setup.ts',
      'DA:1,1',
      'end_of_record',
      '',
    ].join('\n'));
    const coverage = mergeLcovReports([fixture], repositoryRoot, 'win32');
    const summary = summarizeCoverage(coverage, {
      productionFilesDiscovered: ['src/stores/chat.ts', 'src/services/missing.ts'],
    });
    expect(summary.totals.lines).toEqual({ available: true, found: 2, hit: 1, percent: 50 });
    expect(summary.totals.functions).toEqual({ available: false, found: null, hit: null, percent: null });
    expect(summary.totals.branches.available).toBe(false);
    expect(summary.domains.stores.lines.percent).toBe(50);
    expect(summary.uninstrumentedFiles).toEqual(['src/services/missing.ts']);
    expect(domainForSource('src/components/chat/ChatZone.tsx')).toBe('components/chat');
    expect(domainForSource('src/unknown.ts')).toBe('other');
    expect(serializeLcov(filterCoverageSources(coverage))).not.toContain('chat.test.ts');
  });
});

describe('coverage artifact lifecycle', () => {
  test('rejects an empty report instead of silently publishing incomplete coverage', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    const testsDirectory = path.join(repositoryRoot, 'coverage', 'tests');
    await mkdir(path.join(testsDirectory, 'empty'), { recursive: true });
    await writeFile(path.join(testsDirectory, 'empty', 'lcov.info'), '');
    await expect(collectCoverageReports(testsDirectory)).rejects.toThrow(/coverage report is empty/);
  });

  test('removes stale artifacts before a run and collects reports deterministically', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    const paths = coveragePaths(repositoryRoot);
    await mkdir(path.join(paths.tests, 'stale'), { recursive: true });
    await writeFile(path.join(paths.tests, 'stale', 'lcov.info'), 'stale');
    await writeFile(paths.lcov, 'stale');
    await writeFile(paths.summary, 'stale');

    await prepareCoverageRun(repositoryRoot);
    expect(await stat(paths.tests).then(() => true)).toBe(true);
    expect(await readFile(paths.lcov, 'utf8').then(() => true, () => false)).toBe(false);
    expect(await collectCoverageReports(paths.tests)).toEqual([]);
  });

  test('writes a partial aggregate before test failures are reported', async () => {
    const repositoryRoot = await makeTemporaryRepository();
    const paths = await prepareCoverageRun(repositoryRoot);
    await mkdir(path.join(repositoryRoot, 'src', 'stores'), { recursive: true });
    await writeFile(path.join(repositoryRoot, 'src', 'stores', 'chat.ts'), 'export const chat = true;\n');
    await mkdir(path.join(paths.tests, 'first'), { recursive: true });
    await writeFile(path.join(paths.tests, 'first', 'lcov.info'), [
      'SF:src\\stores\\chat.ts',
      'FNF:1',
      'FNH:1',
      'DA:1,1',
      'end_of_record',
      '',
    ].join('\n'));

    const result = await writeCoverageArtifacts({
      repositoryRoot,
      selectedTestFiles: ['first.test.ts', 'missing.test.ts'],
      availableTestFiles: 10,
      completedTestFiles: 2,
      failedTestFiles: ['missing.test.ts'],
      coverageDirectoryFor: (root, file) => path.join(root, file.startsWith('first') ? 'first' : 'missing'),
    });
    expect(result.summary.partial).toBe(true);
    expect(result.summary.reportsMissing).toEqual(['missing.test.ts']);
    expect(result.summary.testFilesFailed).toEqual(['missing.test.ts']);
    expect(result.summary.testFilesAvailable).toBe(10);
    expect(await readFile(paths.lcov, 'utf8')).toContain('SF:src/stores/chat.ts');
    expect(JSON.parse(await readFile(paths.summary, 'utf8')).totals.lines.percent).toBe(100);
  });
});
