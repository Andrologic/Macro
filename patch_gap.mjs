import fs from 'fs';
const path = 'src/components/ui/DiffMergeView.tsx';
let data = fs.readFileSync(path, 'utf8');
data = data.replace(
  "backgroundColor: 'var(--border)',",
  "backgroundColor: 'transparent',"
);
fs.writeFileSync(path, data, 'utf8');
