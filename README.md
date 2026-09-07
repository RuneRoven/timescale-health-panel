# TimescaleDB Health — Grafana panel plugin

One glanceable board of every hypertable: **freshness, size, compression**, in
the andon design language (state-only colour, mono tabular numbers, UMH accent),
following the Grafana theme natively via `useStyles2`.

Built on the `state-plugin` scaffold (React + TS, `@grafana/*`, swc/webpack).

> **UMH template.** A self-contained, compiled Grafana panel. The loadable
> build ships in `dist/` (and `custom-timescale-health-panel-<ver>.zip`); source
> here rebuilds it. Local test stack: `../local-testbed` mounts this `dist/`.
> Works on every TimescaleDB 2.x — no per-database SQL install (see below).

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

## Install for a customer

Unsigned plugin — Grafana needs the files in its plugins dir **and** the id
allow-listed.

1. **Files** — unzip so the folder name equals the id:
   ```bash
   unzip custom-timescale-health-panel-1.0.8.zip -d /var/lib/grafana/plugins/
   # -> /var/lib/grafana/plugins/custom-timescale-health-panel/
   ```
2. **Allow the unsigned id** — `grafana.ini`:
   ```ini
   [plugins]
   allow_loading_unsigned_plugins = custom-timescale-health-panel
   ```
   or env: `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=custom-timescale-health-panel`
3. **Restart Grafana.** Confirm the log line
   `Plugin registered pluginId=custom-timescale-health-panel`.
4. **Use it** — add a panel, pick visualization **TimescaleDB Health**, set the
   panel option **Data source** to the customer's Postgres/TimescaleDB. No SQL,
   no DB install step. The datasource role needs only SELECT on the hypertables.

Docker Grafana:
```yaml
volumes:
  - ./custom-timescale-health-panel:/var/lib/grafana/plugins/custom-timescale-health-panel:ro
environment:
  - GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=custom-timescale-health-panel
```

For a managed/public Grafana that refuses unsigned plugins, sign it with
`@grafana/sign-plugin` (needs a Grafana Cloud API key) — a separate step.

## Troubleshooting: panel stuck on "Loading plugin panel…" / blank

Not this plugin. Grafana ships **preload apps** (e.g. `grafana-lokiexplore-app`,
`grafana-exploretraces-app`, `grafana-pyroscope-app`,
`grafana-metricsdrilldown-app`) whose `module.js` can 404 on `react/jsx-runtime`.
That failed preload throws inside Grafana's shared plugin-load `Promise.all` and
**aborts the loader for every panel plugin** — so this panel (and any other custom
panel) never mounts. Console shows:

```
SystemJS: failed to resolve 'react/jsx-runtime'
Could not load plugin: 404 ... react/jsx-runtime from .../grafana-lokiexplore-app/module.js
```

Fix — disable the offending apps (note: **comma-separated**; a space-separated
value is silently ignored):

```
GF_PLUGINS_DISABLE_PLUGINS=grafana-lokiexplore-app,grafana-exploretraces-app,grafana-metricsdrilldown-app,grafana-pyroscope-app
```

or in `grafana.ini`:

```ini
[plugins]
disable_plugins = grafana-lokiexplore-app,grafana-exploretraces-app,grafana-metricsdrilldown-app,grafana-pyroscope-app
```

Restart Grafana. Confirmed on Grafana 11.6.1; keep the app you actually use.

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
