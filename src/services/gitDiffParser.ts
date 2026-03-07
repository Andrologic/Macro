export type ParsedDiffLineType = 'context' | 'added' | 'removed';

export interface ParsedDiffLine {
  type: ParsedDiffLineType;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface ParsedDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
}

export interface ParsedDiffContent {
  originalContent: string;
  modifiedContent: string;
  additions: number;
  deletions: number;
  hunks: ParsedDiffHunk[];
}

export const parseUnifiedDiff = (patch: string): ParsedDiffContent => {
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  const hunks: ParsedDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let currentHunk: ParsedDiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const line of patch.split('\n')) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      currentHunk = {
        header: line,
        oldStart: Number.parseInt(hunkMatch[1], 10),
        oldCount: Number.parseInt(hunkMatch[2] || '1', 10),
        newStart: Number.parseInt(hunkMatch[3], 10),
        newCount: Number.parseInt(hunkMatch[4] || '1', 10),
        lines: [],
      };
      hunks.push(currentHunk);
      oldLineNumber = currentHunk.oldStart;
      newLineNumber = currentHunk.newStart;
      continue;
    }

    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      continue;
    }

    if (line === '\\ No newline at end of file') {
      continue;
    }

    if (line.startsWith('+')) {
      const content = line.slice(1);
      modifiedLines.push(content);
      additions += 1;
      currentHunk?.lines.push({
        type: 'added',
        content,
        oldLineNumber: null,
        newLineNumber,
      });
      newLineNumber += 1;
      continue;
    }

    if (line.startsWith('-')) {
      const content = line.slice(1);
      originalLines.push(content);
      deletions += 1;
      currentHunk?.lines.push({
        type: 'removed',
        content,
        oldLineNumber,
        newLineNumber: null,
      });
      oldLineNumber += 1;
      continue;
    }

    const content = line.startsWith(' ') ? line.slice(1) : line;
    originalLines.push(content);
    modifiedLines.push(content);
    currentHunk?.lines.push({
      type: 'context',
      content,
      oldLineNumber,
      newLineNumber,
    });
    oldLineNumber += 1;
    newLineNumber += 1;
  }

  return {
    originalContent: originalLines.join('\n'),
    modifiedContent: modifiedLines.join('\n'),
    additions,
    deletions,
    hunks,
  };
};
