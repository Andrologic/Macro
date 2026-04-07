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
