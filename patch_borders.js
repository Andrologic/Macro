const fs = require('fs');

const path = 'src/components/modals/FileChangesDiffModal.tsx';
let data = fs.readFileSync(path, 'utf8');

// Remove border from main container
data = data.replace(
  'rounded-[20px] border bg-background shadow-2xl ring-1 ring-border/50',
  'rounded-[20px] bg-background shadow-2xl'
);

// Remove border-r from aside
data = data.replace(
  'border-r bg-muted/20',
  'bg-muted/10'
);

// Remove border-b from aside header
data = data.replace(
  'border-b p-4',
  'p-4'
);

// Remove border-b from main header
data = data.replace(
  'border-b px-4 py-3',
  'px-4 py-3'
);

// Remove ring from context buttons container
data = data.replace(
  'bg-muted/40 p-1 ring-1 ring-border/50',
  'bg-muted/40 p-1'
);

// Remove ring from active context button
data = data.replace(
  'shadow-sm ring-1 ring-border',
  'shadow-sm'
);

// Remove border-t from footer
data = data.replace(
  'border-t bg-card/95 px-6 py-4',
  'bg-card/95 px-6 py-4'
);

fs.writeFileSync(path, data, 'utf8');
