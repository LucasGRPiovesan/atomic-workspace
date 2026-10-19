// Compact unified line diff, computed locally (LCS on lines, trimmed to hunks with context).
export interface DiffLine { op: ' ' | '+' | '-' | '…'; text: string }

const MAX_LINES = 2000;

export function lineDiff(oldText: string | null, newText: string, context = 2): DiffLine[] {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText.split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [{ op: '…', text: `diff too large (${a.length} → ${b.length} lines)` }];
  }
  // trim common prefix/suffix so the LCS table stays small
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { mid.push({ op: ' ', text: x[i]! }); i++; j++; }
    else if (i < x.length && (j >= y.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { mid.push({ op: '-', text: x[i]! }); i++; }
    else { mid.push({ op: '+', text: y[j]! }); j++; }
  }
  const all: DiffLine[] = [
    ...a.slice(Math.max(0, start - context), start).map((text) => ({ op: ' ' as const, text })),
    ...mid,
    ...a.slice(endA, endA + context).map((text) => ({ op: ' ' as const, text })),
  ];
  const hidden = Math.max(0, start - context);
  return hidden > 0 ? [{ op: '…', text: `${hidden} unchanged lines` }, ...all] : all;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === '+') added++;
    else if (l.op === '-') removed++;
  }
  return { added, removed };
}
