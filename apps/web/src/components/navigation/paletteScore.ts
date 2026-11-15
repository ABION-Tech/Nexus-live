// Session 61 — ranking for the command palette (CommandPalette.tsx).
/** Every letter of the query, in order (so "mtk" finds "My Tasks"), with
 * word starts and contiguous runs ranked first. Exported for tests. */
export function score(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at === 0) return 100;
  if (at > 0) return t[at - 1] === ' ' ? 80 : 60;
  let i = 0;
  let s = 0;
  let last = -2;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      s += j === last + 1 ? 3 : j === 0 || t[j - 1] === ' ' ? 2 : 1;
      last = j;
      i++;
    }
  }
  return i === q.length ? s : 0;
}

