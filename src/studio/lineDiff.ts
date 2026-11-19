export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  text: string;
}

export interface CompactFileDiff {
  addedCount: number;
  removedCount: number;
  lines: DiffLine[];
  truncated: boolean;
}

export function computeCompactLineDiff(
  beforeText: string | undefined,
  afterText: string,
  maxDisplayLines = 40
): CompactFileDiff {
  const beforeLines = beforeText !== undefined ? beforeText.split('\n') : [];
  const afterLines = afterText.split('\n');

  // If brand-new file, emit additions directly
  if (beforeText === undefined) {
    const sliced = afterLines.slice(0, maxDisplayLines).map((text) => ({
      type: 'add' as const,
      text,
    }));
    return {
      addedCount: afterLines.length,
      removedCount: 0,
      lines: sliced,
      truncated: afterLines.length > maxDisplayLines,
    };
  }

  // LCS matrix for bounded sizes, fallback to trimmed prefix/suffix diff for very large files
  const maxLcs = 250;
  if (beforeLines.length <= maxLcs && afterLines.length <= maxLcs) {
    const m = beforeLines.length;
    const n = afterLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (beforeLines[i] === afterLines[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    const raw: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (beforeLines[i] === afterLines[j]) {
        raw.push({ type: 'context', text: beforeLines[i] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        raw.push({ type: 'remove', text: beforeLines[i] });
        i += 1;
      } else {
        raw.push({ type: 'add', text: afterLines[j] });
        j += 1;
      }
    }
    while (i < m) {
      raw.push({ type: 'remove', text: beforeLines[i] });
      i += 1;
    }
    while (j < n) {
      raw.push({ type: 'add', text: afterLines[j] });
      j += 1;
    }

    const addedCount = raw.filter((l) => l.type === 'add').length;
    const removedCount = raw.filter((l) => l.type === 'remove').length;

    // Keep context lines within 1 line of any change to stay compact
    const compact = raw.filter((line, idx) => {
      if (line.type !== 'context') return true;
      const prevChanged = idx > 0 && raw[idx - 1].type !== 'context';
      const nextChanged = idx + 1 < raw.length && raw[idx + 1].type !== 'context';
      return prevChanged || nextChanged;
    });

    return {
      addedCount,
      removedCount,
      lines: compact.slice(0, maxDisplayLines),
      truncated: compact.length > maxDisplayLines,
    };
  }

  // Fallback for huge files
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  const removed = beforeLines.slice(prefix).map((text) => ({ type: 'remove' as const, text }));
  const added = afterLines.slice(prefix).map((text) => ({ type: 'add' as const, text }));
  const combined = [...removed.slice(0, maxDisplayLines / 2), ...added.slice(0, maxDisplayLines / 2)];
  return {
    addedCount: added.length,
    removedCount: removed.length,
    lines: combined,
    truncated: removed.length + added.length > combined.length,
  };
}
