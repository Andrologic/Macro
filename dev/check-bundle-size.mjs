import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

// Optional fresh-build directory for the performance runner; the budgets are identical.
const ASSETS_DIR = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist/assets/', import.meta.url));

const BUDGETS = [
  // Application code follows Rollup's dependency graph; vendor libraries keep stable manual chunks.
  // AgSDL 0.2 and bounded develop stabilization measure about 1,633,000 B
  // for the application entry. Keep about 1% headroom above the combined build.
  { name: 'entry', pattern: /^(?:index|main)-.*\.js$/, limitBytes: 1_650_000 },
  { name: 'max-chunk', pattern: /\.js$/, limitBytes: 600_000, exclude: /^(?:index|main)-.*\.js$/ },
  { name: 'chat-zone', pattern: /^ChatZone-.*\.js$/, limitBytes: 204_000 },
  // The 0.1.7 task recovery fix builds a 61,741 B chunk; keep a narrow margin.
  { name: 'task-queue', pattern: /^TaskQueue-.*\.js$/, limitBytes: 62_000 },
  { name: 'markdown-rich-content', pattern: /^MarkdownRichContent-.*\.js$/, limitBytes: 70_000 },
  // The combined locales measure 141,796 B (es), 144,891 B (de),
  // 147,826 B (fr), 148,609 B (ko), and 164,614 B (ja).
  // Keep about 1% headroom, with the shared fr/ko budget based on ko.
  { name: 'locale-fragment-es', pattern: /^es-.*\.js$/, limitBytes: 143_300 },
  { name: 'locale-fragment-de', pattern: /^de-.*\.js$/, limitBytes: 146_400 },
  { name: 'locale-fragment-fr-ko', pattern: /^(fr|ko)-.*\.js$/, limitBytes: 150_100 },
  { name: 'locale-fragment-ja', pattern: /^ja-.*\.js$/, limitBytes: 166_300 },
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
