import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { PanelProps, GrafanaTheme2, PanelData } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { TimescaleOptions, Hypertable, Tone } from '../types';
import { parseHypertables, parseSummary, parseRegular, parseJobs, parseFreshness } from '../utils/dataParser';
import { runQueries } from '../utils/fetch';
import { BOARD, SUMMARY, REGULAR, JOBS, freshnessSql, codecsSql, chunksSql, ingestSql } from '../queries';
import { fmtBytes, fmtRows, fmtPct, fmtAge, fmtInterval, fmtEta, fmtDate } from '../utils/format';
import { DetailView } from './DetailView';

interface Props extends PanelProps<TimescaleOptions> {}
const STATE = { green: '#00C22D', yellow: '#FFB600', red: '#FF4800' };

function toneOf(h: Hypertable, staleMs: number, now: number): Tone {
  if (h.lastWrite === null) { return 'idle'; }
  if (now - h.lastWrite > staleMs) { return 'stale'; }
  if (h.compressionEnabled && h.compressedChunks === 0 && h.chunks > 1) { return 'warn'; }
  return 'ok';
}
const toneColor = (t: Tone, muted: string) =>
  t === 'ok' ? STATE.green : t === 'warn' ? STATE.yellow : t === 'stale' ? STATE.red : muted;
function fmtDaysToFull(d: number | null): string {
  if (d == null) { return '—'; }
  if (d > 1825) { return 'fits (>5y)'; }
  if (d > 365) { return (d / 365).toFixed(1) + 'y'; }
  return Math.round(d) + 'd';
}
// Estimated size once the uncompressed chunks compress too: the already-
// compressed bytes, plus the uncompressed remainder divided by the ratio. When
// no ratio is known yet, assume 10x (the same optimistic default the original
// dashboard used) so the bar shows a plausible target rather than "no estimate".
function estAfterCompression(h: Hypertable): number {
  const uncomp = Math.max(h.sizeBytes - h.compressedBytes, 0);
  const ratio = h.ratio && h.ratio > 0 ? h.ratio : 10;
  return h.compressedBytes + uncomp / ratio;
}

const BLUE_RAMP = ['#0F115B', '#1333CD', '#335EFF', '#5478FF', '#8AA3FF', '#B0C1FF'];
// Colour for a bar under the chosen scheme. `frac` is the value share (0..1),
// `tone` the freshness state. 'brand' = one blue; 'state' = freshness colour;
// 'sequential' = a blue ramp by size; 'green'/'neutral' = single colours.
function barColor(
  scheme: TimescaleOptions['barColorScheme'],
  opts: { frac?: number; tone?: Tone; muted: string }
): string {
  switch (scheme) {
    case 'state':
      return toneColor(opts.tone ?? 'idle', opts.muted);
    case 'sequential': {
      const f = Math.max(0, Math.min(1, opts.frac ?? 0));
      return BLUE_RAMP[Math.min(BLUE_RAMP.length - 1, Math.round((1 - f) * (BLUE_RAMP.length - 1)))];
    }
    case 'classic':
      // Grafana classic green->yellow->red spectrum along the bar length.
      return `linear-gradient(90deg, ${STATE.green} 0%, ${STATE.yellow} 50%, ${STATE.red} 100%)`;
    case 'green': return STATE.green;
    case 'neutral': return opts.muted;
    case 'brand':
    default: return '#335EFF';
  }
}

function compressEta(h: Hypertable, now: number): number | null {
  if (!h.compressAfter || !h.newest) { return null; }
  const days = /(\d+)\s*day/.exec(h.compressAfter);
  const hms = /^(\d+):(\d+):/.exec(h.compressAfter);
  let ms = days ? parseInt(days[1], 10) * 86400000 : hms ? (parseInt(hms[1], 10) * 3600 + parseInt(hms[2], 10) * 60) * 1000 : 0;
  return ms ? Math.round((h.newest + ms - now) / 1000) : null;
}

export const TimescaleHealthPanel: React.FC<Props> = ({ options, width, height, timeRange }) => {
  const s = useStyles2(getStyles);
  const now = Date.now();
  const staleMs = Math.max(1, options.staleMinutes) * 60000;
  const dsUid = options.datasourceUid;
  const fromMs = timeRange.from.valueOf();
  const toMs = timeRange.to.valueOf();

  const [board, setBoard] = useState<PanelData | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Hypertable | null>(null);
  const [detail, setDetail] = useState<PanelData | null>(null);
  const [fresh, setFresh] = useState<Record<string, number | null>>({});

  // main fetch — the panel runs its own SQL; the dashboard has no queries.
  useEffect(() => {
    if (!dsUid) { return; }
    let alive = true;
    setLoading(true);
    runQueries(dsUid, fromMs, toMs, [
      { refId: 'board', sql: BOARD }, { refId: 'summary', sql: SUMMARY },
      { refId: 'regular', sql: REGULAR }, { refId: 'jobs', sql: JOBS },
    ]).then((r) => { if (alive) { setBoard(r.data); setErrors(r.errors); setLoading(false); } })
      .catch((e) => { if (alive) { setErrors({ board: String(e?.message || e) }); setLoading(false); } });
    return () => { alive = false; };
  }, [dsUid, fromMs, toMs]);

  // freshness — a second query, built from the board's own hypertables. Kept
  // separate from BOARD so a permission/type issue on one table's max(ts) never
  // blanks the whole board; each hypertable names its time column differently,
  // so this cannot be a single static query.
  useEffect(() => {
    if (!dsUid || !board) { return; }
    const hs = parseHypertables(board).filter((h) => h.tscol && h.tscolIsTime);
    if (!hs.length) { setFresh({}); return; }
    let alive = true;
    const sql = freshnessSql(hs.map((h) => ({ schema: h.schema, name: h.name, tscol: h.tscol as string })));
    runQueries(dsUid, fromMs, toMs, [{ refId: 'fresh', sql }])
      .then((r) => { if (alive) { setFresh(parseFreshness(r.data)); } });
    return () => { alive = false; };
  }, [dsUid, board, fromMs, toMs]);

  // detail fetch for the selected hypertable
  useEffect(() => {
    if (!dsUid || !sel) { setDetail(null); return; }
    let alive = true;
    const qs = [
      { refId: 'codecs', sql: codecsSql(sel.schema, sel.name) },
      { refId: 'chunks', sql: chunksSql(sel.schema, sel.name) },
    ];
    if (sel.tscol) { qs.push({ refId: 'ingest', sql: ingestSql(sel.schema, sel.name, sel.tscol, fromMs, toMs) }); }
    runQueries(dsUid, fromMs, toMs, qs).then((r) => { if (alive) { setDetail(r.data); } });
    return () => { alive = false; };
  }, [dsUid, sel, fromMs, toMs]);

  const closeDetail = useCallback(() => setSel(null), []);

  const parsed = useMemo(() => {
    if (!board) { return null; }
    let hs = parseHypertables(board).map((h) => ({ ...h, lastWrite: fresh[h.schema + '|' + h.name] ?? h.lastWrite }));
    const hide = (options.hideSchemas || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (hide.length) { hs = hs.filter((h) => !hide.includes(h.schema)); }
    hs.sort((a, b) =>
      options.sortBy === 'name' ? (a.schema + a.name).localeCompare(b.schema + b.name)
      : options.sortBy === 'freshness' ? (b.lastWrite ?? 0) - (a.lastWrite ?? 0)
      : b.sizeBytes - a.sizeBytes);
    return { cards: hs, summary: parseSummary(board), regular: parseRegular(board), jobs: parseJobs(board),
             totalRows: hs.reduce((a, h) => a + (h.rows ?? 0), 0),
             perDay: hs.reduce((a, h) => a + (h.bytesPerDay ?? 0), 0) };
  }, [board, fresh, options.hideSchemas, options.sortBy]);

  if (!dsUid) {
    return <div className={s.empty}>Pick a PostgreSQL / TimescaleDB datasource in the panel options (Data source).</div>;
  }
  if (errors.board) {
    return <div className={s.error}>Query failed: {errors.board}
      <div className={s.hint}>The datasource user needs SELECT on the hypertables and EXECUTE on the
        supported TimescaleDB functions (granted to PUBLIC by default). No helper install is required.</div></div>;
  }
  if (!parsed || (loading && !board)) { return <div className={s.empty}>Loading…</div>; }
  const { cards, summary, regular, jobs, totalRows, perDay } = parsed;
  if (!cards.length) { return <div className={s.empty}>No hypertables found.</div>; }

  const stale = cards.filter((h) => toneOf(h, staleMs, now) === 'stale').length;
  const chunksC = summary.chunksCompressed ?? cards.reduce((a, h) => a + h.compressedChunks, 0);
  const chunksT = summary.chunksTotal ?? cards.reduce((a, h) => a + h.chunks, 0);
  const diskBytes = (options.diskGb || 0) * 1e9;
  const dbSize = summary.dbSizeBytes ?? cards.reduce((a, h) => a + h.sizeBytes, 0);
  const pctUsed = diskBytes ? (dbSize / diskBytes) * 100 : null;
  const daysToFull = diskBytes && perDay > 0 ? Math.max(0, (diskBytes - dbSize) / perDay) : null;
  const maxReg = regular.reduce((a, r) => Math.max(a, r.sizeBytes), 1);
  const maxSize = cards.reduce((a, h) => Math.max(a, h.sizeBytes), 1);
  const scheme = options.barColorScheme;

  return (
    <div className={s.root} style={{ width, height }}>
      {options.showHeader && (
        <div className={s.header}>
          <span className={s.brand}>UMH</span>
          <span className={s.htitle}>TimescaleDB<span className={s.hintInline}> · click a hypertable for detail</span></span>
          <Stat label="db size" value={fmtBytes(dbSize)} />
          <Stat label="rows" value={fmtRows(totalRows)} />
          <Stat label="hypertables" value={String(summary.hypertables ?? cards.length)} />
          <Stat label="chunks" value={chunksC + '/' + chunksT} />
          <Stat label="cache hit" value={fmtPct(summary.cacheHitPct)} />
          <Stat label="stale" value={String(stale)} tone={stale ? STATE.red : undefined} />
          <Stat label="failed jobs" value={summary.failedJobs != null ? String(summary.failedJobs) : '—'}
                tone={summary.failedJobs ? STATE.red : undefined} />
        </div>
      )}
      {options.showHeader && (
        <div className={s.subrow}>
          <Mini label="commits" value={fmtRows(summary.commits)} />
          <Mini label="tuples inserted" value={fmtRows(summary.tuplesInserted)} />
          <Mini label="WAL written" value={fmtBytes(summary.walBytes)} />
        </div>
      )}

      {options.showProjection && diskBytes > 0 && (
        <div className={s.section}>
          <div className={s.secHead}>Storage projection · {options.diskGb} GB disk</div>
          <div className={s.projRow}>
            <div className={s.projBar}>
              <div className={s.projFill} style={{ width: Math.min(100, pctUsed ?? 0) + '%',
                background: (pctUsed ?? 0) > 85 ? STATE.red : (pctUsed ?? 0) > 65 ? STATE.yellow : STATE.green }} />
            </div>
            <Mini label="used" value={fmtPct(pctUsed)} />
            <Mini label="avg / day" value={fmtBytes(perDay)} />
            <Mini label="days to full" value={fmtDaysToFull(daysToFull)}
                  tone={daysToFull != null && daysToFull < 30 ? STATE.red : undefined} />
          </div>
        </div>
      )}

      <div className={s.grid}>
        {cards.map((h) => {
          const tone = toneOf(h, staleMs, now);
          const col = toneColor(tone, 'var(--ts-muted)');
          const eta = compressEta(h, now);
          const uncomp = h.chunks - h.compressedChunks;
          const active = sel && sel.schema === h.schema && sel.name === h.name;
          return (
            <div key={h.schema + '.' + h.name}
                 className={active ? s.cardActive : s.card}
                 style={{ borderLeftColor: col }}
                 onClick={() => setSel(active ? null : h)} title="Click for detail">
              <div className={s.top}>
                <span className={s.name}>{h.name}</span>
                <span className={s.schema}>{h.schema}</span>
                <span className={s.more + ' ts-more'}>{active ? 'close ×' : 'detail ›'}</span>
              </div>
              <div className={s.hero}>
                <span className={s.dot} style={{ background: col }} />
                <span className={s.age} style={{ color: col }}>{fmtAge(h.lastWrite, now)}</span>
                <span className={s.size}>{fmtBytes(h.sizeBytes)}</span>
              </div>
              <div className={s.parts}>
                <Part k="rows" v={fmtRows(h.rows)} />
                <Part k="chunks" v={h.compressedChunks + '/' + h.chunks} />
                <Part k="compress" v={h.ratio ? h.ratio.toFixed(1) + '×' : (h.compressionEnabled ? 'pending' : 'off')} />
              </div>
              <div className={s.parts}>
                <Part k="span" v={h.oldest ? fmtDate(h.oldest) + '→' + fmtDate(h.newest) : '—'} />
                <Part k="retention" v={fmtInterval(h.dropAfter)} />
                <Part k="next comp" v={h.compressAfter && uncomp > 0 ? fmtEta(eta) : (h.compressionEnabled ? '—' : 'off')} />
              </div>
            </div>
          );
        })}
      </div>

      {sel && <DetailView title={sel.schema + '.' + sel.name} ht={sel} data={detail} onClose={closeDetail} />}

      {options.showSizes && (
        <div className={s.section}>
          <div className={s.secHead}>Hypertable sizes · current, and estimated after compression</div>
          {cards.map((h) => {
            const est = estAfterCompression(h);
            const frac = h.sizeBytes / maxSize;
            const col = barColor(scheme, { frac, tone: toneOf(h, staleMs, now), muted: 'var(--ts-muted)' });
            return (
              <div key={h.schema + '.' + h.name} className={s.sizeRow}>
                <span className={s.sizeName} title={h.schema + '.' + h.name}>{h.name}</span>
                <div className={s.sizeTrack}>
                  {/* full bar = current size; inner marker = estimated compressed size */}
                  <div className={s.sizeFill} style={{ width: (frac * 100) + '%', background: col }} />
                  <div className={s.sizeEst}
                       style={{ width: ((est / maxSize) * 100) + '%' }}
                       title={'est. after compression ' + fmtBytes(est)} />
                </div>
                <span className={s.sizeVal}>{fmtBytes(h.sizeBytes)}
                  <span className={s.sizeEstVal}> → {fmtBytes(est)}</span></span>
              </div>
            );
          })}
        </div>
      )}

      {options.showRegular && regular.length > 0 && (
        <div className={s.section}>
          <div className={s.secHead}>Largest regular tables</div>
          {regular.map((r) => (
            <div key={r.name} className={s.regRow}>
              <span className={s.regName} title={r.name}>{r.name}</span>
              <div className={s.regBar}><div className={s.regFill}
                style={{ width: (r.sizeBytes / maxReg * 100) + '%',
                         background: barColor(scheme, { frac: r.sizeBytes / maxReg, muted: 'var(--ts-muted)' }) }} /></div>
              <span className={s.regSize}>{fmtBytes(r.sizeBytes)}</span>
            </div>
          ))}
        </div>
      )}

      {options.showJobs && jobs.length > 0 && (
        <div className={s.section}>
          <div className={s.secHead}>Background jobs</div>
          <div className={s.jobs}>
            {jobs.map((j) => {
              const bad = /fail/i.test(j.status);
              return (
                <div key={String(j.id) + j.name} className={s.jobRow}>
                  <span className={s.jobName} title={j.name}>{j.name}</span>
                  <span className={s.jobHt}>{j.hypertable || '—'}</span>
                  <span className={s.jobEvery}>{fmtInterval(j.every)}</span>
                  <span className={s.jobStatus} style={{ color: bad ? STATE.red : /success/i.test(j.status) ? STATE.green : 'var(--ts-muted)' }}>{j.status}</span>
                  <span className={s.jobNext}>{j.nextStart ? 'in ' + fmtAge(j.nextStart, now) : '—'}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => {
  const s = useStyles2(getStyles);
  return <span className={s.stat}><span className={s.statv} style={tone ? { color: tone } : undefined}>{value}</span><span className={s.statk}>{label}</span></span>;
};
const Mini: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => {
  const s = useStyles2(getStyles);
  return <span className={s.mini}><span className={s.miniv} style={tone ? { color: tone } : undefined}>{value}</span><span className={s.statk}>{label}</span></span>;
};
const Part: React.FC<{ k: string; v: string }> = ({ k, v }) => {
  const s = useStyles2(getStyles);
  return <span className={s.part}><span className={s.partk}>{k}</span><span className={s.partv}>{v}</span></span>;
};

const getStyles = (t: GrafanaTheme2) => {
  const mono = 'ui-monospace,"Roboto Mono",Menlo,monospace';
  const num = css`font-family:${mono}; font-variant-numeric:tabular-nums;`;
  const card = `border:1px solid ${t.colors.border.weak}; border-left:3px solid ${t.colors.border.medium};
      border-radius:2px; background:${t.colors.background.secondary}; padding:9px 11px;
      display:flex; flex-direction:column; gap:6px; cursor:pointer; transition:border-color .1s;
      &:hover { border-color:#335EFF; } &:hover .ts-more { color:#335EFF; }`;
  return {
    root: css`--ts-muted:${t.colors.text.secondary}; color:${t.colors.text.primary};
      font-family:${t.typography.fontFamily}; overflow:auto; padding:8px;`,
    empty: css`color:${t.colors.text.secondary}; padding:20px; font-style:italic;`,
    error: css`color:${STATE.red}; padding:16px; font-size:13px;`,
    hint: css`color:${t.colors.text.secondary}; font-size:12px; margin-top:8px; code{font-family:${mono};}`,
    header: css`display:flex; align-items:center; gap:16px; padding:4px 6px 10px; border-bottom:1px solid ${t.colors.border.weak}; flex-wrap:wrap;`,
    subrow: css`display:flex; gap:16px; padding:6px 6px 10px; border-bottom:1px solid ${t.colors.border.weak}; margin-bottom:10px;`,
    brand: css`font-weight:800; letter-spacing:1.5px; color:#335EFF; font-size:18px;`,
    htitle: css`text-transform:uppercase; letter-spacing:.06em; font-size:13px; color:${t.colors.text.secondary}; margin-right:auto;`,
    stat: css`display:flex; flex-direction:column; align-items:flex-end;`,
    statv: css`${num}; font-size:18px; font-weight:600;`,
    statk: css`font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:${t.colors.text.secondary};`,
    mini: css`display:flex; flex-direction:column; align-items:flex-start;`,
    miniv: css`${num}; font-size:14px; font-weight:600;`,
    section: css`margin-top:14px;`,
    secHead: css`font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:${t.colors.text.secondary}; margin-bottom:8px;`,
    projRow: css`display:flex; align-items:center; gap:18px;`,
    projBar: css`flex:1 1 auto; height:18px; border-radius:2px; background:${t.colors.background.secondary}; border:1px solid ${t.colors.border.weak}; overflow:hidden;`,
    projFill: css`height:100%;`,
    grid: css`display:grid; gap:8px; grid-template-columns:repeat(auto-fill, minmax(240px,1fr)); margin-top:12px;`,
    card: css`${card}`,
    cardActive: css`${card} outline:2px solid #335EFF; outline-offset:-1px;`,
    top: css`display:flex; justify-content:space-between; align-items:baseline; gap:8px; min-width:0;`,
    name: css`font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`,
    more: css`flex:0 0 auto; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:${t.colors.text.secondary};`,
    hintInline: css`text-transform:none; letter-spacing:0; color:${t.colors.text.disabled}; font-weight:400;`,
    schema: css`font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:${t.colors.text.secondary}; flex:0 0 auto;`,
    hero: css`display:flex; align-items:center; gap:9px; min-width:0;`,
    dot: css`width:10px; height:10px; border-radius:50%; flex:0 0 10px;`,
    age: css`font-size:21px; font-weight:700; ${num};`,
    size: css`margin-left:auto; font-size:12px; ${num}; color:${t.colors.text.secondary};`,
    parts: css`display:flex; gap:12px; flex-wrap:wrap;`,
    part: css`display:flex; align-items:baseline; gap:4px;`,
    partk: css`font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:${t.colors.text.secondary};`,
    partv: css`font-size:12px; ${num}; color:${t.colors.text.secondary};`,
    sizeRow: css`display:flex; align-items:center; gap:12px; margin:4px 0;`,
    sizeName: css`flex:0 0 200px; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`,
    sizeTrack: css`flex:1 1 auto; position:relative; height:16px; background:${t.colors.background.secondary}; border-radius:2px; overflow:hidden;`,
    sizeFill: css`position:absolute; left:0; top:0; bottom:0; border-radius:2px;`,
    sizeEst: css`position:absolute; left:0; top:0; bottom:0; border-right:2px solid ${t.colors.text.primary}; opacity:.55;`,
    sizeVal: css`flex:0 0 auto; font-size:12px; font-family:ui-monospace,Menlo,monospace; font-variant-numeric:tabular-nums; color:${t.colors.text.secondary};`,
    sizeEstVal: css`color:${t.colors.text.disabled};`,
    regRow: css`display:flex; align-items:center; gap:12px; margin:4px 0;`,
    regName: css`flex:0 0 220px; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`,
    regBar: css`flex:1 1 auto; height:14px; background:${t.colors.background.secondary}; border-radius:2px; overflow:hidden;`,
    regFill: css`height:100%; background:#335EFF;`,
    regSize: css`flex:0 0 auto; font-size:12px; ${num}; color:${t.colors.text.secondary};`,
    jobs: css`display:flex; flex-direction:column; gap:2px;`,
    jobRow: css`display:grid; grid-template-columns:1fr 140px 44px 80px 80px; gap:10px; font-size:12px; padding:3px 0; align-items:center;`,
    jobName: css`overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`,
    jobHt: css`color:${t.colors.text.secondary}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`,
    jobEvery: css`${num}; color:${t.colors.text.secondary};`,
    jobStatus: css`font-weight:600;`,
    jobNext: css`${num}; color:${t.colors.text.secondary}; text-align:right;`,
  };
};
