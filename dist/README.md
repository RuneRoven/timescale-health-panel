# TimescaleDB Health — Grafana panel plugin

One glanceable board of every hypertable: **freshness, size, compression**, in
the andon design language (state-only colour, mono tabular numbers, UMH accent),
following the Grafana theme natively via `useStyles2`.

Built on the `state-plugin` scaffold (React + TS, `@grafana/*`, swc/webpack).

## What it shows

- A card per hypertable. **Left accent = freshness state:**
  green (written within the threshold), **red** (stale — no write for longer
  than *Stale after*), grey (empty). A hypertable that *could* compress but has
  no compressed chunk yet is **yellow "pending"**. Colour means state and
  nothing else — sizes, rows and chunk counts stay grey.
- Per card: last-write age (big), size, rows, `compressed/total` chunks, and the
  compression ratio (`8.4×` / `pending` / `off`).
- Optional header: db size, hypertable count, stale count, failed jobs.

## How it gets data — no SQL in the dashboard

The panel **runs its own SQL** (baked into `src/queries.ts`) against the
datasource picked in its options, via `getBackendSrv().post('/api/ds/query')`.
So a dashboard using this panel has **no query editor content** and the user
never sees SQL — they set only:

- **Data source** — the Postgres / TimescaleDB connection (a datasource picker).
- Stale threshold, disk size (for the projection), sort, hidden schemas, and
  which sections to show.

**No install prerequisites** (since v1.0.8). The panel uses only supported,
version-stable TimescaleDB catalog views and functions — compression via
`hypertable_compression_stats()` (definer-rights, no grant needed), freshness via
a per-table `max(<time col>)` union it builds itself. Works on every TimescaleDB
2.x (tested 2.5 → 2.29). The datasource role needs only SELECT on the hypertables.

## Metrics (parity with the 22-panel dashboard)

- **Header:** db size, total rows, hypertables, chunks (comp/total), cache hit,
  stale count, failed jobs; commits / tuples inserted / WAL.
- **Storage projection:** size vs disk, % used, avg/day, days-to-full.
- **Hypertable cards:** freshness+age, size, rows, chunks comp/total, compression
  ratio (`×` / pending / off), data span, retention, next-compress ETA.
- **Largest regular tables**, and **background jobs** (status, interval, next run).
- **Click a card → drill-down:** ingest rate (rows/hour over the range),
  column codecs, and the chunk list — the per-table `${ht}` panels, without a
  separate variable.

## Options

`Stale after (minutes)` · `Sort by` (size / freshness / name) ·
`Hide schemas` (comma list) · `Show summary header`.

## Build & run

```bash
npm run typecheck && npm run build      # -> dist/

# local test harness: Grafana + a seeded TimescaleDB with four hypertables
# in four different states (fresh+compressed, compression-pending, stale, plain)
cd dev && docker compose up -d
open http://localhost:3001/d/tsdb-health-plugin      # anonymous admin
```

The seed (`dev/sql/00-seed.sql`) deliberately produces one green, one yellow,
one red and one grey card so every state is visible at once.

## Notes

- `dist/` is the loadable plugin. To try it on another Grafana, mount `dist/`
  into `/var/lib/grafana/plugins/custom-timescale-health-panel` and allow the
  unsigned id.
- Unsigned: for production it needs signing, or the allow-unsigned env var.
- This is a compiled plugin, a better home for the health board than the
  22-native-panel `timescale-metrics` dashboard — one panel, one query pair,
  the design language baked in and theme-following for free.
