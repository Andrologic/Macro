import path from 'node:path';

const TEST_FILE_PATTERN = /\.(?:test|spec|scenarios)\.(?:ts|tsx|js|jsx)$/i;

function parseNonNegativeInteger(value, context) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid non-negative integer "${value}" in ${context}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Counter exceeds JavaScript's safe integer range in ${context}.`);
  }
  return parsed;
}

function addSafe(left, right, context) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Merged counter exceeds JavaScript's safe integer range in ${context}.`);
  }
  return result;
}

export function normalizeSourcePath(source, repositoryRoot, platform = process.platform) {
  const slashPath = source.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!slashPath || path.isAbsolute(source) || /^[a-zA-Z]:\//.test(slashPath)) {
    throw new Error(`Coverage source must be a relative repository path: "${source}".`);
  }

  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(root, ...slashPath.split('/'));
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Coverage source escapes the repository: "${source}".`);
  }

  const normalized = relative.replaceAll('\\', '/');
  return {
    path: normalized,
    key: platform === 'win32' ? normalized.toLowerCase() : normalized,
  };
}

export function parseLcov(text, reportPath = '<memory>') {
  const records = [];
  const sources = new Set();
  let current = null;

  const requireRecord = (lineNumber, entry) => {
    if (!current) {
      throw new Error(`${reportPath}:${lineNumber}: ${entry} appears outside an SF record.`);
    }
  };

  const finishRecord = (lineNumber) => {
    if (!current) {
      throw new Error(`${reportPath}:${lineNumber}: unexpected end_of_record.`);
    }
    if (sources.has(current.source)) {
      throw new Error(`${reportPath}:${lineNumber}: duplicate SF record "${current.source}".`);
    }
    sources.add(current.source);
    records.push(current);
    current = null;
  };

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const entry = lines[index];
    const lineNumber = index + 1;
    if (!entry || entry.startsWith('TN:')) {
      continue;
    }
    if (entry.startsWith('SF:')) {
      if (current) {
        throw new Error(`${reportPath}:${lineNumber}: missing end_of_record before the next SF entry.`);
      }
      const source = entry.slice(3).trim();
      if (!source) {
        throw new Error(`${reportPath}:${lineNumber}: empty SF entry.`);
      }
      current = {
        source,
        lines: new Map(),
        functions: new Map(),
        functionHits: new Map(),
        branches: new Map(),
        functionSummaryPresent: false,
        functionFound: null,
        branchSummaryPresent: false,
        branchFound: null,
      };
      continue;
    }
    if (entry === 'end_of_record') {
      finishRecord(lineNumber);
      continue;
    }

    if (entry.startsWith('DA:')) {
      requireRecord(lineNumber, 'DA');
      const match = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(entry);
      if (!match) {
        throw new Error(`${reportPath}:${lineNumber}: malformed DA entry.`);
      }
      const sourceLine = parseNonNegativeInteger(match[1], `${reportPath}:${lineNumber}`);
      const hits = parseNonNegativeInteger(match[2], `${reportPath}:${lineNumber}`);
      current.lines.set(sourceLine, addSafe(current.lines.get(sourceLine) ?? 0, hits, `${reportPath}:${lineNumber}`));
      continue;
    }

    if (entry.startsWith('FN:')) {
      requireRecord(lineNumber, 'FN');
      const match = /^FN:(\d+),(.+)$/.exec(entry);
      if (!match) {
        throw new Error(`${reportPath}:${lineNumber}: malformed FN entry.`);
      }
      const sourceLine = parseNonNegativeInteger(match[1], `${reportPath}:${lineNumber}`);
      const name = match[2];
      const existing = current.functions.get(name);
      if (existing !== undefined && existing !== sourceLine) {
        throw new Error(`${reportPath}:${lineNumber}: conflicting FN metadata for "${name}".`);
      }
      current.functions.set(name, sourceLine);
      continue;
    }

    if (entry.startsWith('FNDA:')) {
      requireRecord(lineNumber, 'FNDA');
      const match = /^FNDA:(\d+),(.+)$/.exec(entry);
      if (!match) {
        throw new Error(`${reportPath}:${lineNumber}: malformed FNDA entry.`);
      }
      const hits = parseNonNegativeInteger(match[1], `${reportPath}:${lineNumber}`);
      const name = match[2];
      current.functionHits.set(name, addSafe(current.functionHits.get(name) ?? 0, hits, `${reportPath}:${lineNumber}`));
      continue;
    }

    if (entry.startsWith('BRDA:')) {
      requireRecord(lineNumber, 'BRDA');
      const match = /^BRDA:(\d+),([^,]+),([^,]+),(\d+|-)$/.exec(entry);
      if (!match) {
        throw new Error(`${reportPath}:${lineNumber}: malformed BRDA entry.`);
      }
      const sourceLine = parseNonNegativeInteger(match[1], `${reportPath}:${lineNumber}`);
      const key = `${sourceLine},${match[2]},${match[3]}`;
      const hits = match[4] === '-' ? null : parseNonNegativeInteger(match[4], `${reportPath}:${lineNumber}`);
      const existing = current.branches.get(key);
      current.branches.set(key, {
        line: sourceLine,
        block: match[2],
        branch: match[3],
        hits: existing?.hits == null
          ? hits
          : hits == null
            ? existing.hits
            : addSafe(existing.hits, hits, `${reportPath}:${lineNumber}`),
      });
      continue;
    }

    if (entry.startsWith('FNF:') || entry.startsWith('FNH:')) {
      requireRecord(lineNumber, entry.slice(0, 3));
      const value = parseNonNegativeInteger(entry.slice(4), `${reportPath}:${lineNumber}`);
      current.functionSummaryPresent = true;
      if (entry.startsWith('FNF:')) current.functionFound = value;
      continue;
    }
    if (entry.startsWith('BRF:') || entry.startsWith('BRH:')) {
      requireRecord(lineNumber, entry.slice(0, 3));
      const value = parseNonNegativeInteger(entry.slice(4), `${reportPath}:${lineNumber}`);
      current.branchSummaryPresent = true;
      if (entry.startsWith('BRF:')) current.branchFound = value;
      continue;
    }
    if (entry.startsWith('LF:') || entry.startsWith('LH:')) {
      requireRecord(lineNumber, entry.slice(0, 2));
      parseNonNegativeInteger(entry.slice(3), `${reportPath}:${lineNumber}`);
    }
  }

  if (current) {
    throw new Error(`${reportPath}: missing end_of_record at end of file.`);
  }
  return records;
}

export function mergeLcovReports(reports, repositoryRoot, platform = process.platform) {
  const sources = new Map();

  for (const report of reports) {
    const reportSources = new Set();
    for (const record of report.records) {
      const normalized = normalizeSourcePath(record.source, repositoryRoot, platform);
      if (reportSources.has(normalized.key)) {
        throw new Error(`Duplicate normalized coverage source "${normalized.path}" in ${report.path}.`);
      }
      reportSources.add(normalized.key);
      let merged = sources.get(normalized.key);
      if (!merged) {
        merged = {
          source: normalized.path,
          lines: new Map(),
          functions: new Map(),
          branches: new Map(),
          functionsAvailable: true,
          branchesAvailable: true,
        };
        sources.set(normalized.key, merged);
      }

      for (const [line, hits] of record.lines) {
        merged.lines.set(line, addSafe(merged.lines.get(line) ?? 0, hits, `${report.path}:${record.source}:${line}`));
      }

      const hasFunctionIdentity = record.functions.size > 0 || record.functionFound === 0;
      if (!hasFunctionIdentity) {
        merged.functionsAvailable = false;
        merged.functions.clear();
      } else if (merged.functionsAvailable) {
        for (const [name, line] of record.functions) {
          const existing = merged.functions.get(name);
          if (existing && existing.line !== line) {
            throw new Error(`Conflicting function metadata for "${name}" in ${normalized.path}.`);
          }
          merged.functions.set(name, {
            line,
            hits: addSafe(existing?.hits ?? 0, record.functionHits.get(name) ?? 0, `${report.path}:${name}`),
          });
        }
      }

      const hasBranchIdentity = record.branches.size > 0 || record.branchFound === 0;
      if (!hasBranchIdentity) {
        merged.branchesAvailable = false;
        merged.branches.clear();
      } else if (merged.branchesAvailable) {
        for (const [key, branch] of record.branches) {
          const existing = merged.branches.get(key);
          merged.branches.set(key, {
            ...branch,
            hits: existing?.hits == null
              ? branch.hits
              : branch.hits == null
                ? existing.hits
                : addSafe(existing.hits, branch.hits, `${report.path}:${key}`),
          });
        }
      }
    }
  }

  return { sources };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumericToken(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return compareText(String(left), String(right));
}

function compareBranches(left, right) {
  return left.line - right.line
    || compareNumericToken(left.block, right.block)
    || compareNumericToken(left.branch, right.branch);
}

export function serializeLcov(coverage) {
  const output = [];
  const sources = [...coverage.sources.values()].sort((left, right) => compareText(left.source, right.source));
  for (const source of sources) {
    output.push('TN:', `SF:${source.source}`);
    if (source.functionsAvailable && source.functions.size > 0) {
      const functions = [...source.functions.entries()].sort((left, right) => left[1].line - right[1].line || compareText(left[0], right[0]));
      for (const [name, entry] of functions) output.push(`FN:${entry.line},${name}`);
      for (const [name, entry] of functions) output.push(`FNDA:${entry.hits},${name}`);
      output.push(`FNF:${functions.length}`, `FNH:${functions.filter(([, entry]) => entry.hits > 0).length}`);
    }
    const lines = [...source.lines.entries()].sort((left, right) => left[0] - right[0]);
    for (const [line, hits] of lines) output.push(`DA:${line},${hits}`);
    output.push(`LF:${lines.length}`, `LH:${lines.filter(([, hits]) => hits > 0).length}`);
    if (source.branchesAvailable && source.branches.size > 0) {
      const branches = [...source.branches.values()].sort(compareBranches);
      for (const branch of branches) output.push(`BRDA:${branch.line},${branch.block},${branch.branch},${branch.hits ?? '-'}`);
      output.push(`BRF:${branches.length}`, `BRH:${branches.filter((branch) => (branch.hits ?? 0) > 0).length}`);
    }
    output.push('end_of_record');
  }
  return `${output.join('\n')}\n`;
}

export function isProductionCoverageSource(source) {
  const normalized = source.replaceAll('\\', '/');
  if (
    TEST_FILE_PATTERN.test(normalized)
    || normalized === 'test-setup.ts'
    || normalized.includes('/__tests__/')
    || normalized.includes('/test-utils/')
  ) {
    return false;
  }
  if (normalized.includes('/generated/') || normalized.endsWith('.d.ts')) {
    return false;
  }
  return normalized.startsWith('src/') || normalized.startsWith('copilot-bridge/src/');
}

export function filterCoverageSources(coverage, predicate = isProductionCoverageSource) {
  return {
    sources: new Map(
      [...coverage.sources.entries()].filter(([, source]) => predicate(source.source)),
    ),
  };
}

export function domainForSource(source) {
  const normalized = source.replaceAll('\\', '/');
  if (normalized.startsWith('copilot-bridge/src/')) return 'copilot-bridge';
  const componentMatch = /^src\/components\/([^/]+)\//.exec(normalized);
  if (componentMatch) return `components/${componentMatch[1]}`;
  for (const domain of ['stores', 'services', 'hooks', 'utils', 'shared', 'shortcuts', 'i18n']) {
    if (normalized.startsWith(`src/${domain}/`)) return domain;
  }
  return 'other';
}

function metric(found, hit, available = true) {
  return {
    available,
    found: available ? found : null,
    hit: available ? hit : null,
    percent: available && found > 0 ? Number(((hit / found) * 100).toFixed(2)) : null,
  };
}

export function summarizeCoverage(coverage, metadata = {}) {
  const productionSources = [...coverage.sources.values()].filter((source) => isProductionCoverageSource(source.source));
  const buildSummary = (sources) => {
    const lineEntries = sources.flatMap((source) => [...source.lines.values()]);
    const functionsAvailable = sources.length > 0 && sources.every((source) => source.functionsAvailable);
    const branchesAvailable = sources.length > 0 && sources.every((source) => source.branchesAvailable);
    const functionEntries = functionsAvailable ? sources.flatMap((source) => [...source.functions.values()]) : [];
    const branchEntries = branchesAvailable ? sources.flatMap((source) => [...source.branches.values()]) : [];
    return {
      files: sources.length,
      lines: metric(lineEntries.length, lineEntries.filter((hits) => hits > 0).length),
      functions: metric(functionEntries.length, functionEntries.filter((entry) => entry.hits > 0).length, functionsAvailable),
      branches: metric(branchEntries.length, branchEntries.filter((entry) => (entry.hits ?? 0) > 0).length, branchesAvailable),
    };
  };

  const domainSources = new Map();
  for (const source of productionSources) {
    const domain = domainForSource(source.source);
    const entries = domainSources.get(domain) ?? [];
    entries.push(source);
    domainSources.set(domain, entries);
  }
  const domains = Object.fromEntries(
    [...domainSources.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([domain, sources]) => [domain, buildSummary(sources)]),
  );

  const discovered = [...new Set(metadata.productionFilesDiscovered ?? [])].sort();
  const instrumented = new Set(productionSources.map((source) => source.source));
  return {
    partial: Boolean(metadata.partial),
    testFilesSelected: metadata.testFilesSelected ?? 0,
    testFilesAvailable: metadata.testFilesAvailable ?? metadata.testFilesSelected ?? 0,
    testFilesCompleted: metadata.testFilesCompleted ?? 0,
    testFilesFailed: metadata.testFilesFailed ?? [],
    reportsFound: metadata.reportsFound ?? 0,
    reportsMissing: metadata.reportsMissing ?? [],
    instrumentedFiles: productionSources.length,
    productionFilesDiscovered: discovered.length,
    uninstrumentedFiles: discovered.filter((source) => !instrumented.has(source)),
    totals: buildSummary(productionSources),
    domains,
  };
}
