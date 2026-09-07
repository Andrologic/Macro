import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ASSETS_DIR = fileURLToPath(new URL('../dist/assets/', import.meta.url));

const BUDGETS = [
  // Application code follows Rollup's dependency graph; vendor libraries keep stable manual chunks.
  // Macro 0.1.5 adds attachments, archives, search, diagnostics, and task review.
  // Linux measures about 1,349,500 B for entry, 57,300 B for TaskQueue,
  // 130,100 B for the largest shared locale, and 143,800 B for ja.
  // Pilot adds desktop integration and translated connection/access settings.
  // The measured production build is 1,355,675 B for entry, 134,029 B for fr,
  // 133,937 B for ko, and 148,180 B for ja. Keep similar headroom to 0.1.5.
  // Pilot's runtime remains a separate 536,156 B chunk under the unchanged cap.
  { name: 'entry', pattern: /^index-.*\.js$/, limitBytes: 1_361_000 },
  { name: 'max-chunk', pattern: /\.js$/, limitBytes: 600_000, exclude: /^index-.*\.js$/ },
  { name: 'chat-zone', pattern: /^ChatZone-.*\.js$/, limitBytes: 115_000 },
  { name: 'task-queue', pattern: /^TaskQueue-.*\.js$/, limitBytes: 58_000 },
  { name: 'markdown-rich-content', pattern: /^MarkdownRichContent-.*\.js$/, limitBytes: 70_000 },
  { name: 'locale-fragment', pattern: /^(de|es|fr|ko)-.*\.js$/, limitBytes: 136_500 },
  { name: 'locale-fragment-ja', pattern: /^ja-.*\.js$/, limitBytes: 150_500 },
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
