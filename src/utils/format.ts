export function fmtBytes(n: number | null): string {
  if (n === null || n === undefined || isNaN(n)) { return '—'; }
  if (n < 1024) { return n + ' B'; }
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}
export function fmtRows(n: number | null): string {
  if (n === null || n === undefined || isNaN(n) || n < 0) { return '—'; }
  if (n >= 1e9) { return (n / 1e9).toFixed(1) + 'B'; }
  if (n >= 1e6) { return (n / 1e6).toFixed(1) + 'M'; }
  if (n >= 1e3) { return (n / 1e3).toFixed(0) + 'k'; }
  return String(n);
}
export function fmtPct(n: number | null): string {
  return n === null || n === undefined || isNaN(n) ? '—' : n.toFixed(1) + '%';
}
export function fmtAge(lastWrite: number | null, now: number): string {
  if (!lastWrite) { return 'no data'; }
  const s = Math.max(0, Math.round((now - lastWrite) / 1000));
  if (s < 45) { return 'just now'; }
  if (s < 3600) { return Math.round(s / 60) + 'm'; }
  if (s < 86400) { return Math.round(s / 3600) + 'h'; }
  return Math.round(s / 86400) + 'd';
}
/** Tidy a Postgres interval text: "90 days"->"90d", "12:00:00"->"12h", "1 day"->"1d". */
export function fmtInterval(iv: string | null): string {
  if (!iv) { return '—'; }
  const d = iv.match(/(\d+)\s*days?/);
  if (d) { return d[1] + 'd'; }
  const hms = iv.match(/^(\d+):(\d+):/);
  if (hms) {
    const h = parseInt(hms[1], 10), m = parseInt(hms[2], 10);
    return h ? h + 'h' : m + 'm';
  }
  return iv;
}
/** "in 3d" / "due" for an ETA given in seconds from now (may be negative). */
export function fmtEta(secs: number | null): string {
  if (secs === null || secs === undefined) { return '—'; }
  if (secs <= 0) { return 'due'; }
  if (secs < 3600) { return 'in ' + Math.round(secs / 60) + 'm'; }
  if (secs < 86400) { return 'in ' + Math.round(secs / 3600) + 'h'; }
  return 'in ' + Math.round(secs / 86400) + 'd';
}
export function fmtDate(ms: number | null): string {
  if (!ms) { return '—'; }
  return new Date(ms).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });
}
