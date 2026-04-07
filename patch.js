const fs = require('fs');

const path = 'src/components/modals/FileChangesDiffModal.tsx';
let data = fs.readFileSync(path, 'utf8');

// 1. Simplify header
// Remove the statusMeta.bg/icon div
data = data.replace(
  /<span[\s\S]*?<Icon name=\{statusMeta\.icon\} size=\{14\} \/>\s*<\/span>/,
  ''
);

// Remove the additions, deletions, read-only/editable badges
data = data.replace(
  /<div className="mt-0\.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">[\s\S]*?<\/div>/,
  '<div className="mt-0.5 text-xs text-muted-foreground">{getFileDir(change.path) || \'/\'}</div>'
);

// 2. Add key to DiffMergeView
data = data.replace(
  '<DiffMergeView\n                original={change.originalContent}',
  '<DiffMergeView\n                key={change.id}\n                original={change.originalContent}'
);

fs.writeFileSync(path, data, 'utf8');
