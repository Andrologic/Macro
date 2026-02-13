export interface ParsedDiffContent {
  originalContent: string;
  modifiedContent: string;
  additions: number;
  deletions: number;
}

export const parseUnifiedDiff = (patch: string): ParsedDiffContent => {
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split('\n')) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@ ')
    ) {
      continue;
    }

    if (line.startsWith('+')) {
      modifiedLines.push(line.slice(1));
      additions += 1;
      continue;
    }

    if (line.startsWith('-')) {
      originalLines.push(line.slice(1));
      deletions += 1;
      continue;
    }

    const content = line.startsWith(' ') ? line.slice(1) : line;
    originalLines.push(content);
    modifiedLines.push(content);
  }

  return {
    originalContent: originalLines.join('\n'),
    modifiedContent: modifiedLines.join('\n'),
    additions,
    deletions,
  };
};
