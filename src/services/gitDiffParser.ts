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

export type ParsedUnifiedDiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface ParsedUnifiedDiffFile {
  oldPath: string | null;
  path: string;
  status: ParsedUnifiedDiffFileStatus;
  additions: number;
  deletions: number;
  patch: string;
}

export type SplitDiffRowKind =
  | 'context'
  | 'added'
  | 'removed'
  | 'modified'
  | 'spacer'
  | 'hunk_header';

export interface SplitDiffRow {
  kind: SplitDiffRowKind;
  leftLineNumber: number | null;
  rightLineNumber: number | null;
  leftContent: string;
  rightContent: string;
}

const splitTextLines = (value: string): string[] => (
  value.length === 0 ? [] : value.split('\n')
);

const buildLcsTable = (left: string[], right: string[]): number[][] => {
  const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      if (left[leftIndex] === right[rightIndex]) {
        table[leftIndex]![rightIndex] = (table[leftIndex + 1]![rightIndex + 1] ?? 0) + 1;
      } else {
        table[leftIndex]![rightIndex] = Math.max(
          table[leftIndex + 1]![rightIndex] ?? 0,
          table[leftIndex]![rightIndex + 1] ?? 0
        );
      }
    }
  }
  return table;
};

interface DiffOp {
  type: 'equal' | 'remove' | 'add';
  value: string;
}

const buildDiffOps = (left: string[], right: string[]): DiffOp[] => {
  const table = buildLcsTable(left, right);
  const operations: DiffOp[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      operations.push({ type: 'equal', value: left[leftIndex]! });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if ((table[leftIndex + 1]![rightIndex] ?? 0) >= (table[leftIndex]![rightIndex + 1] ?? 0)) {
      operations.push({ type: 'remove', value: left[leftIndex]! });
      leftIndex += 1;
    } else {
      operations.push({ type: 'add', value: right[rightIndex]! });
      rightIndex += 1;
    }
  }

  while (leftIndex < left.length) {
    operations.push({ type: 'remove', value: left[leftIndex]! });
    leftIndex += 1;
  }

  while (rightIndex < right.length) {
    operations.push({ type: 'add', value: right[rightIndex]! });
    rightIndex += 1;
  }

  return operations;
};

export const buildParsedDiffFromTextPair = (
  originalContent: string,
  modifiedContent: string
): ParsedDiffContent => {
  const left = splitTextLines(originalContent);
  const right = splitTextLines(modifiedContent);
  const operations = buildDiffOps(left, right);
  const lines: ParsedDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;

  for (const operation of operations) {
    if (operation.type === 'equal') {
      lines.push({
        type: 'context',
        content: operation.value,
        oldLineNumber,
        newLineNumber,
      });
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    if (operation.type === 'remove') {
      deletions += 1;
      lines.push({
        type: 'removed',
        content: operation.value,
        oldLineNumber,
        newLineNumber: null,
      });
      oldLineNumber += 1;
      continue;
    }

    additions += 1;
    lines.push({
      type: 'added',
      content: operation.value,
      oldLineNumber: null,
      newLineNumber,
    });
    newLineNumber += 1;
  }

  return {
    originalContent,
    modifiedContent,
    additions,
    deletions,
    hunks:
      additions === 0 && deletions === 0
        ? []
        : [
            {
              header: `@@ -${left.length > 0 ? 1 : 0},${left.length} +${right.length > 0 ? 1 : 0},${right.length} @@`,
              oldStart: left.length > 0 ? 1 : 0,
              oldCount: left.length,
              newStart: right.length > 0 ? 1 : 0,
              newCount: right.length,
              lines,
            },
          ],
  };
};

export const buildStableLineNumberMap = (
  leftContent: string,
  rightContent: string
): Map<number, number> => {
  const left = splitTextLines(leftContent);
  const right = splitTextLines(rightContent);
  const operations = buildDiffOps(left, right);
  const lineMap = new Map<number, number>();
  let leftLineNumber = 1;
  let rightLineNumber = 1;

  for (const operation of operations) {
    if (operation.type === 'equal') {
      lineMap.set(leftLineNumber, rightLineNumber);
      leftLineNumber += 1;
      rightLineNumber += 1;
      continue;
    }

    if (operation.type === 'remove') {
      leftLineNumber += 1;
      continue;
    }

    rightLineNumber += 1;
  }

  return lineMap;
};

export const buildSplitDiffRows = (originalContent: string, modifiedContent: string): SplitDiffRow[] => {
  const left = splitTextLines(originalContent);
  const right = splitTextLines(modifiedContent);
  const operations = buildDiffOps(left, right);
  const rows: SplitDiffRow[] = [];

  let leftLineNumber = 1;
  let rightLineNumber = 1;

  for (let index = 0; index < operations.length; index += 1) {
    const current = operations[index]!;

    if (current.type === 'equal') {
      rows.push({
        kind: 'context',
        leftLineNumber,
        rightLineNumber,
        leftContent: current.value,
        rightContent: current.value,
      });
      leftLineNumber += 1;
      rightLineNumber += 1;
      continue;
    }

    const removed: string[] = [];
    const added: string[] = [];

    while (index < operations.length && operations[index]!.type !== 'equal') {
      const operation = operations[index]!;
      if (operation.type === 'remove') {
        removed.push(operation.value);
      } else if (operation.type === 'add') {
        added.push(operation.value);
      }
      index += 1;
    }
    index -= 1;

    const rowCount = Math.max(removed.length, added.length);
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const leftValue = removed[rowIndex] ?? '';
      const rightValue = added[rowIndex] ?? '';
      const hasLeft = rowIndex < removed.length;
      const hasRight = rowIndex < added.length;
      rows.push({
        kind: hasLeft && hasRight ? 'modified' : hasLeft ? 'removed' : 'added',
        leftLineNumber: hasLeft ? leftLineNumber : null,
        rightLineNumber: hasRight ? rightLineNumber : null,
        leftContent: leftValue,
        rightContent: rightValue,
      });
      if (hasLeft) {
        leftLineNumber += 1;
      }
      if (hasRight) {
        rightLineNumber += 1;
      }
    }
  }

  return rows;
};

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

const trimGitPathPrefix = (path: string): string => {
  const normalized = path.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"');
  if (normalized === '/dev/null') {
    return normalized;
  }
  return normalized.replace(/^[ab]\//, '');
};

const splitDiffGitPathArgs = (value: string): string[] => {
  const args: string[] = [];
  let current = '';
  let isQuoted = false;
  let isEscaped = false;

  for (const character of value.trim()) {
    if (isEscaped) {
      current += character;
      isEscaped = false;
      continue;
    }

    if (character === '\\' && isQuoted) {
      isEscaped = true;
      current += character;
      continue;
    }

    if (character === '"') {
      isQuoted = !isQuoted;
      current += character;
      continue;
    }

    if (character === ' ' && !isQuoted) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += character;
  }

  if (current) {
    args.push(current);
  }

  return args;
};

const parseDiffGitPaths = (line: string): { oldPath: string | null; path: string } | null => {
  if (!line.startsWith('diff --git ')) {
    return null;
  }

  const args = splitDiffGitPathArgs(line.slice('diff --git '.length));
  if (args.length < 2) {
    return null;
  }

  return {
    oldPath: trimGitPathPrefix(args[0] ?? ''),
    path: trimGitPathPrefix(args[1] ?? ''),
  };
};

const resolveUnifiedDiffFile = (lines: string[]): ParsedUnifiedDiffFile | null => {
  if (lines.length === 0) {
    return null;
  }

  let oldPath: string | null = null;
  let path = 'Repository diff';
  let status: ParsedUnifiedDiffFileStatus = 'modified';
  let renameFrom: string | null = null;
  let renameTo: string | null = null;

  for (const line of lines) {
    const diffPaths = parseDiffGitPaths(line);
    if (diffPaths) {
      oldPath = diffPaths.oldPath;
      path = diffPaths.path;
      continue;
    }

    if (line.startsWith('new file mode')) {
      status = 'added';
      continue;
    }

    if (line.startsWith('deleted file mode')) {
      status = 'deleted';
      continue;
    }

    if (line.startsWith('rename from ')) {
      renameFrom = trimGitPathPrefix(line.slice('rename from '.length));
      status = 'renamed';
      continue;
    }

    if (line.startsWith('rename to ')) {
      renameTo = trimGitPathPrefix(line.slice('rename to '.length));
      status = 'renamed';
      continue;
    }

    if (line.startsWith('--- ')) {
      const candidate = trimGitPathPrefix(line.slice(4));
      if (candidate === '/dev/null') {
        oldPath = null;
        status = 'added';
      } else {
        oldPath = candidate;
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      const candidate = trimGitPathPrefix(line.slice(4));
      if (candidate === '/dev/null') {
        status = 'deleted';
      } else {
        path = candidate;
      }
    }
  }

  if (renameFrom) {
    oldPath = renameFrom;
  }
  if (renameTo) {
    path = renameTo;
  }

  const patch = lines.join('\n');
  const parsed = parseUnifiedDiff(patch);

  return {
    oldPath,
    path,
    status,
    additions: parsed.additions,
    deletions: parsed.deletions,
    patch,
  };
};

export const parseUnifiedDiffFiles = (patch: string): ParsedUnifiedDiffFile[] => {
  const lines = patch.split('\n');
  const files: ParsedUnifiedDiffFile[] = [];
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const currentFile = resolveUnifiedDiffFile(currentLines);
      if (currentFile) {
        files.push(currentFile);
      }
      currentLines = [line];
      continue;
    }

    if (currentLines.length > 0) {
      currentLines.push(line);
    }
  }

  const currentFile = resolveUnifiedDiffFile(currentLines);
  if (currentFile) {
    files.push(currentFile);
  }

  return files;
};
