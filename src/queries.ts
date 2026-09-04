/**
 * All the SQL the panel runs, baked in. The panel executes these itself against
 * the datasource chosen in its options, so a dashboard needs no query editor and
 * the user never sees SQL. Identical on every deployment.
 *
 * No install-time prerequisites: every query here uses only supported,
 * version-stable TimescaleDB catalog views and functions (2.x through 2.29+).
 * Compression figures come from the supported `hypertable_compression_stats()`
 * (definer-rights, no internal-catalog grant needed); freshness is a separate
 * per-table `max(<time col>)` union built in JS (see freshnessSql), because the
 * time column is named differently in every hypertable. Nothing depends on the
 * old `hypertable_freshness()` / `hypertable_compression_detail` helpers.
 */

/** One row per hypertable. */
export const BOARD = `
WITH pol AS (
  SELECT hypertable_schema hs, hypertable_name hn,
         max((config->>'compress_after')::interval) FILTER (WHERE proc_name LIKE '%compress%') compress_after,
         max((config->>'drop_after')::interval)     FILTER (WHERE proc_name LIKE '%retention%') drop_after
    FROM timescaledb_information.jobs GROUP BY 1,2),
span AS (
  SELECT hypertable_schema hs, hypertable_name hn, min(range_start) oldest, max(range_end) newest, count(*) chunks
    FROM timescaledb_information.chunks GROUP BY 1,2),
dim AS (
  SELECT hypertable_schema hs, hypertable_name hn, column_name AS tscol,
         (column_type IN ('timestamp with time zone','timestamp without time zone','date')) AS ts_is_time
    FROM timescaledb_information.dimensions WHERE dimension_number=1)
SELECT h.hypertable_schema AS schema, h.hypertable_name AS hypertable,
       hypertable_size(format('%I.%I',h.hypertable_schema,h.hypertable_name)::regclass) AS size_bytes,
       cs.ratio, COALESCE(cs.bytes_after,0) AS compressed_bytes,
       approximate_row_count(format('%I.%I',h.hypertable_schema,h.hypertable_name)::regclass) AS rows,
       s.chunks, COALESCE(cs.compressed_chunks,0) AS compressed_chunks, h.compression_enabled,
       pol.compress_after, pol.drop_after, s.oldest, s.newest, dim.tscol, dim.ts_is_time,
       round(hypertable_size(format('%I.%I',h.hypertable_schema,h.hypertable_name)::regclass)
             / GREATEST(EXTRACT(EPOCH FROM (s.newest - s.oldest))/86400.0, 0.5)) AS bytes_per_day
  FROM timescaledb_information.hypertables h
  -- Compression totals from the supported, version-stable stats function. It
  -- reports BYTES (not rows), returns a NULL row for an uncompressed hypertable
  -- (so the LEFT JOIN LATERAL never drops a row), and runs with definer rights
  -- so a read-only Grafana role needs no grant on the internal catalog.
  LEFT JOIN LATERAL (
    SELECT number_compressed_chunks AS compressed_chunks,
           after_compression_total_bytes AS bytes_after,
           CASE WHEN after_compression_total_bytes > 0
                THEN round(before_compression_total_bytes::numeric / after_compression_total_bytes, 1) END AS ratio
      FROM hypertable_compression_stats(format('%I.%I',h.hypertable_schema,h.hypertable_name)::regclass)
  ) cs ON true
  LEFT JOIN pol  ON pol.hs=h.hypertable_schema AND pol.hn=h.hypertable_name
  LEFT JOIN span s ON s.hs=h.hypertable_schema AND s.hn=h.hypertable_name
  LEFT JOIN dim ON dim.hs=h.hypertable_schema AND dim.hn=h.hypertable_name
  ORDER BY size_bytes DESC`;

export const SUMMARY = `
SELECT pg_database_size(current_database()) AS db_size,
  (SELECT count(*) FROM timescaledb_information.hypertables) AS hypertables,
  (SELECT count(*) FROM timescaledb_information.chunks) AS chunks_total,
  (SELECT count(*) FROM timescaledb_information.chunks WHERE is_compressed) AS chunks_compressed,
  (SELECT count(*) FROM timescaledb_information.job_stats WHERE last_run_status='Failed') AS failed_jobs,
  (SELECT round(100.0*sum(heap_blks_hit)/NULLIF(sum(heap_blks_hit)+sum(heap_blks_read),0),1) FROM pg_statio_user_tables) AS cache_hit_pct,
  (SELECT sum(xact_commit) FROM pg_stat_database WHERE datname=current_database()) AS commits,
  (SELECT sum(n_tup_ins) FROM pg_stat_user_tables) AS tuples_inserted,
  (SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),'0/0')) AS wal_bytes`;

export const REGULAR = `
SELECT c.relnamespace::regnamespace||'.'||c.relname AS name, pg_total_relation_size(c.oid) AS size_bytes
  FROM pg_class c
 WHERE c.relkind='r'
   AND c.relnamespace::regnamespace::text NOT LIKE 'X_timescaledb%' ESCAPE 'X'
   AND c.relnamespace::regnamespace::text NOT IN ('pg_catalog','information_schema')
   AND NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables h WHERE h.hypertable_name=c.relname)
 ORDER BY 2 DESC LIMIT 8`;

export const JOBS = `
SELECT j.job_id, j.application_name AS job, COALESCE(j.hypertable_name,'-') AS hypertable,
       j.schedule_interval::text AS every, js.last_run_status AS status,
       js.last_successful_finish AS last_success, j.next_start, js.total_runs
  FROM timescaledb_information.jobs j
  LEFT JOIN timescaledb_information.job_stats js USING (job_id)
 ORDER BY j.job_id`;

/** Last-write per hypertable — one `max(<time col>)` per table, unioned. Built
 *  in JS because each hypertable names its time column differently; only
 *  time-typed dimensions are included (integer-partitioned tables have no
 *  meaningful wall-clock freshness). Needs only SELECT on the caller's own
 *  hypertables, so it works for a locked-down reader with no helper function. */
export function freshnessSql(
  hts: Array<{ schema: string; name: string; tscol: string }>
): string {
  const parts = hts.map((h) => {
    const S = h.schema.replace(/"/g, ''), N = h.name.replace(/"/g, ''), C = h.tscol.replace(/"/g, '');
    const SL = S.replace(/'/g, "''"), NL = N.replace(/'/g, "''");
    return `SELECT '${SL}'::text s, '${NL}'::text n, max("${C}")::timestamptz lw FROM "${S}"."${N}"`;
  });
  return parts.join('\nUNION ALL\n');
}

/** Per-hypertable detail (the ${ht} drill-down panels), parameterised by name. */
export function codecsSql(schema: string, name: string): string {
  const S = schema.replace(/'/g, "''"), N = name.replace(/'/g, "''");
  return `
SELECT c.column_name AS column, c.data_type AS type,
  CASE WHEN cs.segmentby_column_index IS NOT NULL THEN 'segment-by'
       WHEN cs.orderby_column_index IS NOT NULL OR c.data_type LIKE 'timestamp%' OR c.data_type='date' THEN 'delta-delta'
       WHEN c.data_type IN ('bigint','integer','smallint') THEN 'delta-delta'
       WHEN c.data_type IN ('double precision','real','numeric') THEN 'gorilla'
       WHEN c.data_type='boolean' THEN 'bool'
       WHEN c.data_type='text' OR c.data_type LIKE 'character%' THEN 'dictionary'
       ELSE 'array' END AS codec
  FROM information_schema.columns c
  LEFT JOIN timescaledb_information.compression_settings cs
         ON cs.hypertable_schema='${S}' AND cs.hypertable_name='${N}' AND cs.attname=c.column_name
 WHERE c.table_schema='${S}' AND c.table_name='${N}'
 ORDER BY c.ordinal_position`;
}

export function chunksSql(schema: string, name: string): string {
  const S = schema.replace(/'/g, "''"), N = name.replace(/'/g, "''");
  return `
SELECT c.chunk_name AS chunk, c.is_compressed AS compressed,
       to_char(c.range_start,'MM-DD HH24:MI') AS from_ts,
       to_char(c.range_end,'MM-DD HH24:MI') AS to_ts,
       pg_size_pretty(pg_total_relation_size(format('%I.%I',c.chunk_schema,c.chunk_name)::regclass)) AS size
  FROM timescaledb_information.chunks c
 WHERE c.hypertable_schema='${S}' AND c.hypertable_name='${N}'
 ORDER BY c.range_start DESC LIMIT 30`;
}

/** Ingest rate — rows per hour over the given range, bucketed on the table's
 *  own primary time column (passed in from the board query). */
export function ingestSql(schema: string, name: string, tscol: string, fromMs: number, toMs: number): string {
  const from = new Date(fromMs).toISOString(), to = new Date(toMs).toISOString();
  const rel = '"' + schema.replace(/"/g, '') + '"."' + name.replace(/"/g, '') + '"';
  const tc = '"' + tscol.replace(/"/g, '') + '"';
  return `SELECT time_bucket('1 hour', ${tc}) AS time, count(*) AS rows
  FROM ${rel} WHERE ${tc} BETWEEN '${from}' AND '${to}'
 GROUP BY 1 ORDER BY 1`;
}
