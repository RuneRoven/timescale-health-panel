import { PanelData, Field } from '@grafana/data';
import { Hypertable, Summary, RegularTable, Job } from '../types';

function col(fields: Field[], ...names: string[]): Field | undefined {
  for (const n of names) { const f = fields.find((x) => x.name === n); if (f) { return f; } }
  return undefined;
}
function num(f: Field | undefined, i: number): number | null {
  if (!f) { return null; }
  const v = f.values[i];
  if (v === null || v === undefined || v === '') { return null; }
  const n = typeof v === 'number' ? v : Number(v);
  return isNaN(n) ? null : n;
}
function str(f: Field | undefined, i: number): string {
  const v = f && f.values[i];
  return v === null || v === undefined ? '' : String(v);
}
function toMs(f: Field | undefined, i: number): number | null {
  if (!f) { return null; }
  const v = f.values[i];
  if (v === null || v === undefined || v === '') { return null; }
  if (typeof v === 'number') { return v < 1e12 ? v * 1000 : v; }
  const t = new Date(String(v).replace(' ', 'T')).getTime();
  return isNaN(t) ? null : t;
}
function boolAt(f: Field | undefined, i: number): boolean {
  const v = f && f.values[i];
  return v === true || v === 't' || v === 'true' || v === 1;
}
function seriesWith(data: PanelData, ...cols: string[]) {
  return data.series.find((s) => cols.some((c) => s.fields.some((f) => f.name === c)));
}

export function parseHypertables(data: PanelData): Hypertable[] {
  const s = seriesWith(data, 'hypertable', 'hypertable_name');
  if (!s) { return []; }
  const f = s.fields;
  const name = col(f, 'hypertable', 'hypertable_name');
  const n = name ? name.values.length : 0;
  const out: Hypertable[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      schema: str(col(f, 'schema', 'hypertable_schema'), i),
      name: str(name, i),
      lastWrite: toMs(col(f, 'last_write'), i),
      sizeBytes: num(col(f, 'size_bytes', 'size'), i) ?? 0,
      compressedBytes: num(col(f, 'compressed_bytes'), i) ?? 0,
      ratio: num(col(f, 'ratio'), i),
      rows: num(col(f, 'rows', 'row_count'), i),
      compRows: num(col(f, 'comp_rows'), i),
      chunks: num(col(f, 'chunks', 'num_chunks'), i) ?? 0,
      compressedChunks: num(col(f, 'compressed_chunks'), i) ?? 0,
      compressionEnabled: boolAt(col(f, 'compression_enabled'), i) || (num(col(f, 'compressed_chunks'), i) ?? 0) > 0,
      compressAfter: str(col(f, 'compress_after'), i) || null,
      dropAfter: str(col(f, 'drop_after'), i) || null,
      oldest: toMs(col(f, 'oldest'), i),
      newest: toMs(col(f, 'newest'), i),
      bytesPerDay: num(col(f, 'bytes_per_day'), i),
      tscol: str(col(f, 'tscol'), i) || null,
      tscolIsTime: boolAt(col(f, 'ts_is_time'), i),
    });
  }
  return out;
}

export function parseSummary(data: PanelData): Summary {
  const s = seriesWith(data, 'db_size', 'failed_jobs', 'cache_hit_pct');
  const f = s ? s.fields : [];
  return {
    dbSizeBytes: num(col(f, 'db_size'), 0),
    hypertables: num(col(f, 'hypertables'), 0),
    chunksTotal: num(col(f, 'chunks_total'), 0),
    chunksCompressed: num(col(f, 'chunks_compressed'), 0),
    failedJobs: num(col(f, 'failed_jobs'), 0),
    cacheHitPct: num(col(f, 'cache_hit_pct'), 0),
    commits: num(col(f, 'commits'), 0),
    tuplesInserted: num(col(f, 'tuples_inserted'), 0),
    walBytes: num(col(f, 'wal_bytes'), 0),
  };
}

export function parseRegular(data: PanelData): RegularTable[] {
  const s = data.series.find((x) =>
    x.fields.some((f) => f.name === 'name') && x.fields.some((f) => f.name === 'size_bytes')
    && !x.fields.some((f) => f.name === 'hypertable' || f.name === 'hypertable_name'));
  if (!s) { return []; }
  const f = s.fields, nm = col(f, 'name'), sz = col(f, 'size_bytes');
  const out: RegularTable[] = [];
  const n = nm ? nm.values.length : 0;
  for (let i = 0; i < n; i++) { out.push({ name: str(nm, i), sizeBytes: num(sz, i) ?? 0 }); }
  return out;
}

export function parseJobs(data: PanelData): Job[] {
  const s = seriesWith(data, 'status', 'next_start');
  if (!s || !s.fields.some((f) => f.name === 'job' || f.name === 'application_name')) { return []; }
  const f = s.fields, jid = col(f, 'job_id', 'id');
  const out: Job[] = [];
  const n = jid ? jid.values.length : 0;
  for (let i = 0; i < n; i++) {
    out.push({
      id: num(jid, i),
      name: str(col(f, 'job', 'application_name'), i),
      hypertable: str(col(f, 'hypertable', 'hypertable_name'), i),
      every: str(col(f, 'every', 'schedule_interval'), i),
      status: str(col(f, 'status', 'last_run_status'), i) || 'Scheduled',
      lastSuccess: toMs(col(f, 'last_success', 'last_successful_finish'), i),
      nextStart: toMs(col(f, 'next_start'), i),
      totalRuns: num(col(f, 'total_runs'), i),
    });
  }
  return out;
}

/** Freshness result: rows of (s, n, lw) from freshnessSql. Keyed schema|name. */
export function parseFreshness(data: PanelData): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const sr = data.series.find((x) =>
    x.fields.some((f) => f.name === 'lw') && x.fields.some((f) => f.name === 'n'));
  if (!sr) { return out; }
  const f = sr.fields, sc = col(f, 's'), nm = col(f, 'n'), lw = col(f, 'lw');
  const n = nm ? nm.values.length : 0;
  for (let i = 0; i < n; i++) { out[str(sc, i) + '|' + str(nm, i)] = toMs(lw, i); }
  return out;
}
