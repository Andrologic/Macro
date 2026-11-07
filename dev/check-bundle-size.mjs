import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

// Optional fresh-build directory for the performance runner; the budgets are identical.
const ASSETS_DIR = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist/assets/', import.meta.url));

const BUDGETS = [
  // Application code follows Rollup's dependency graph; vendor libraries keep stable manual chunks.
  // The combined AgSDL/Connect build measures 1,497,142 B; tighten develop's 1,542,000 B ceiling.
  { name: 'entry', pattern: /^(?:index|main)-.*\.js$/, limitBytes: 1_505_000 },
  { name: 'native-client', pattern: /^nativeClient-.*\.js$/, limitBytes: 830_000 },
  { name: 'pilot-desktop', pattern: /^macroPilotDesktop-.*\.js$/, limitBytes: 651_000 },
  { name: 'max-chunk', pattern: /\.js$/, limitBytes: 600_000, exclude: /^(?:index|main|nativeClient|macroPilotDesktop)-.*\.js$/ },
  { name: 'chat-zone', pattern: /^ChatZone-.*\.js$/, limitBytes: 204_000 },
  // Develop measured TaskQueue at 63,040 B; retain a 160 B margin.
  { name: 'task-queue', pattern: /^TaskQueue-.*\.js$/, limitBytes: 63_200 },
  { name: 'markdown-rich-content', pattern: /^MarkdownRichContent-.*\.js$/, limitBytes: 70_000 },
  // Completed Pilot translations in the merged locales measure 157,555 B (es),
  // 161,171 B (de), 162,175 B (fr), 165,085 B (ko), and 185,153 B (ja).
  // Keep about 1% headroom, with the shared fr/ko budget based on ko.
  { name: 'locale-fragment-es', pattern: /^es-.*\.js$/, limitBytes: 159_200 },
  { name: 'locale-fragment-de', pattern: /^de-.*\.js$/, limitBytes: 162_800 },
  { name: 'locale-fragment-fr-ko', pattern: /^(fr|ko)-.*\.js$/, limitBytes: 166_800 },
  { name: 'locale-fragment-ja', pattern: /^ja-.*\.js$/, limitBytes: 187_100 },
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
