import fs from 'fs';
const path = 'src/components/ui/DiffMergeView.tsx';
let data = fs.readFileSync(path, 'utf8');
data = data.replace(
  "border: '1px solid var(--border)',",
  "border: 'none',"
);
fs.writeFileSync(path, data, 'utf8');
