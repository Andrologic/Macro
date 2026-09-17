import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ASSETS_DIR = fileURLToPath(new URL('../dist/assets/', import.meta.url));

const BUDGETS = [
  // Application code follows Rollup's dependency graph; vendor libraries keep stable manual chunks.
  // Integrated merge recovery and lifecycle fixes measure 1,452,987 B for entry.
  // Completed translations measure about 132,900 B for the largest shared locale
  // and 146,950 B for Japanese. Keep about 1% headroom and retain vendor limits.
  { name: 'entry', pattern: /^index-.*\.js$/, limitBytes: 1_465_000 },
  { name: 'max-chunk', pattern: /\.js$/, limitBytes: 600_000, exclude: /^index-.*\.js$/ },
  { name: 'chat-zone', pattern: /^ChatZone-.*\.js$/, limitBytes: 118_500 },
  { name: 'task-queue', pattern: /^TaskQueue-.*\.js$/, limitBytes: 61_500 },
  { name: 'markdown-rich-content', pattern: /^MarkdownRichContent-.*\.js$/, limitBytes: 70_000 },
  { name: 'locale-fragment', pattern: /^(de|es|fr|ko)-.*\.js$/, limitBytes: 134_000 },
  { name: 'locale-fragment-ja', pattern: /^ja-.*\.js$/, limitBytes: 148_000 },
];

const formatKiB = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const assetFiles = readdirSync(ASSETS_DIR)
  .filter((fileName) => fileName.endsWith('.js'))
  .map((fileName) => ({
    fileName,
    sizeBytes: statSync(join(ASSETS_DIR, fileName)).size,
  }));

const failures = [];

for (const budget of BUDGETS) {
  const candidates = assetFiles.filter(({ fileName }) => {
    if (!budget.pattern.test(fileName)) {
      return false;
    }
    if (budget.exclude && budget.exclude.test(fileName)) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    continue;
  }

  const oversizedCandidates = candidates
    .filter((candidate) => candidate.sizeBytes > budget.limitBytes)
    .sort((left, right) => right.sizeBytes - left.sizeBytes);

  for (const candidate of oversizedCandidates) {
    failures.push(
      `${budget.name}: ${candidate.fileName} is ${formatKiB(candidate.sizeBytes)} (limit ${formatKiB(budget.limitBytes)})`
    );
  }
}

if (failures.length > 0) {
  console.error('Bundle size budget exceeded:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Bundle size budgets passed.');
