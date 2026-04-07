import fs from 'fs';
const path = 'src/components/modals/FileChangesDiffModal.tsx';
let data = fs.readFileSync(path, 'utf8');

// Undo pt-6 in aside
data = data.replace(
  '        <aside className="flex w-[200px] shrink-0 flex-col bg-muted/10 pt-6">\n          <div className="p-4">',
  '        <aside className="flex w-[200px] shrink-0 flex-col bg-muted/10">\n          <div className="p-4">'
);

// Undo pt-6 in main
data = data.replace(
  '        <main className="flex min-w-0 flex-1 flex-col bg-background pt-6">\n          <header className="flex shrink-0 items-center justify-between px-4 py-3">',
  '        <main className="flex min-w-0 flex-1 flex-col bg-background">\n          <header className="flex shrink-0 items-center justify-between px-4 py-3">'
);

// Update bounding box
data = data.replace(
  'className="fixed inset-0 z-[95] flex items-center justify-center bg-background/50 backdrop-blur-sm"',
  'className="fixed inset-0 z-[95] flex items-center justify-center bg-background/50 backdrop-blur-sm p-4 pt-14 sm:p-6 sm:pt-16"'
);

data = data.replace(
  '      <div className="flex h-[94vh] w-[96vw] max-w-[1800px] overflow-hidden rounded-xl bg-background shadow-2xl">',
  '      <div className="flex h-[calc(100vh-6rem)] w-[calc(100vw-3rem)] max-w-[1800px] overflow-hidden rounded-xl bg-background shadow-2xl ring-1 ring-border/10">'
);

fs.writeFileSync(path, data, 'utf8');
