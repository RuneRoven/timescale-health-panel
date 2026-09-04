import React from 'react';
import { GrafanaTheme2, PanelData } from '@grafana/data';
import { Hypertable } from '../types';
import { fmtBytes, fmtRows } from '../utils/format';
import { useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

interface Row { [k: string]: unknown; }
function frameRows(data: PanelData, mustHave: string): Row[] {
  const s = data.series.find((x) => x.fields.some((f) => f.name === mustHave));
  if (!s) { return []; }
  const n = s.fields[0]?.values.length ?? 0;
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const r: Row = {};
    s.fields.forEach((f) => (r[f.name] = f.values[i]));
    out.push(r);
  }
  return out;
}

export const DetailView: React.FC<{ title: string; ht: Hypertable; data: PanelData | null; onClose: () => void }> = ({ title, ht, data, onClose }) => {
  const s = useStyles2(styles);
  const codecs = data ? frameRows(data, 'codec') : [];
  const chunks = data ? frameRows(data, 'chunk') : [];
  const ingest = data ? frameRows(data, 'rows').filter((r) => 'time' in r) : [];
  const peak = ingest.reduce((a, r) => Math.max(a, Number(r.rows) || 0), 0);
  const avg = ingest.length ? Math.round(ingest.reduce((a, r) => a + (Number(r.rows) || 0), 0) / ingest.length) : 0;

  // compressed vs uncompressed, from the board row (no extra query)
  const totalRows = ht.rows ?? 0;
  const compRows = ht.compRows ?? 0;
  const uncompRows = Math.max(totalRows - compRows, 0);
  const compBytes = ht.compressedBytes ?? 0;
  const uncompBytes = Math.max(ht.sizeBytes - compBytes, 0);
  const brc = compRows > 0 ? (compBytes / compRows) : null;
  const bru = uncompRows > 0 ? (uncompBytes / uncompRows) : null;

  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <span className={s.title}>{title}</span>
        <button className={s.close} onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className={s.compbar}>
        <div className={s.compHead}>Compressed vs uncompressed</div>
        <div className={s.compGrid}>
          <div className={s.compCol}>
            <div className={s.compTag} style={{ color: '#00C22D' }}>compressed</div>
            <CV k="rows" v={fmtRows(compRows)} /><CV k="size" v={fmtBytes(compBytes)} />
            <CV k="B/row" v={brc == null ? '—' : brc.toFixed(1)} />
            <CV k="ratio" v={ht.ratio ? ht.ratio.toFixed(1) + '×' : '—'} />
          </div>
          <div className={s.compCol}>
            <div className={s.compTag}>uncompressed</div>
            <CV k="rows" v={fmtRows(uncompRows)} /><CV k="size" v={fmtBytes(uncompBytes)} />
            <CV k="B/row" v={bru == null ? '—' : bru.toFixed(1)} />
            <CV k="saving" v={brc && bru ? (100 * (1 - brc / bru)).toFixed(0) + '%' : '—'} />
          </div>
        </div>
      </div>
      <div className={s.cols}>
        <div className={s.col}>
          <div className={s.h}>Ingest — rows / hour (dashboard range)</div>
          <div className={s.spark}>
            {ingest.map((r, i) => (
              <span key={i} className={s.bar} title={String(r.time) + ' · ' + r.rows}
                    style={{ height: peak ? Math.max(2, (Number(r.rows) / peak) * 40) + 'px' : '2px' }} />
            ))}
            {!ingest.length && <span className={s.muted}>no rows in range</span>}
          </div>
          <div className={s.stat}>peak {peak}/h · avg {avg}/h</div>

          <div className={s.h} style={{ marginTop: 14 }}>Column codecs</div>
          <table className={s.tbl}><tbody>
            {codecs.map((r, i) => (
              <tr key={i}><td>{String(r.column)}</td><td className={s.muted}>{String(r.type)}</td><td>{String(r.codec)}</td></tr>
            ))}
          </tbody></table>
        </div>
        <div className={s.col}>
          <div className={s.h}>Chunks (newest first)</div>
          <table className={s.tbl}><thead><tr><th>chunk</th><th>range</th><th>size</th><th></th></tr></thead><tbody>
            {chunks.map((r, i) => (
              <tr key={i}>
                <td className={s.muted}>{String(r.chunk).replace(/^_hyper_/, '')}</td>
                <td>{String(r.from_ts)}</td>
                <td>{String(r.size)}</td>
                <td>{r.compressed === true || r.compressed === 't' ? '🗜' : ''}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </div>
  );
};

const CV: React.FC<{ k: string; v: string }> = ({ k, v }) => {
  const s = useStyles2(styles);
  return <span className={s.cv}><span className={s.cvk}>{k}</span><span className={s.cvv}>{v}</span></span>;
};

const styles = (t: GrafanaTheme2) => {
  const mono = 'ui-monospace,"Roboto Mono",Menlo,monospace';
  return {
    wrap: css`margin-top:14px; border:1px solid ${t.colors.border.medium}; border-radius:2px;
      background:${t.colors.background.secondary}; padding:12px 14px;`,
    head: css`display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;`,
    title: css`font-size:14px; font-weight:600;`,
    close: css`background:none; border:1px solid ${t.colors.border.weak}; color:${t.colors.text.secondary};
      border-radius:2px; width:26px; height:26px; cursor:pointer; font-size:16px; line-height:1;`,
    cols: css`display:grid; grid-template-columns:1fr 1fr; gap:20px; @media (max-width:720px){grid-template-columns:1fr;}`,
    col: css``,
    h: css`font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:${t.colors.text.secondary}; margin-bottom:6px;`,
    spark: css`display:flex; align-items:flex-end; gap:2px; height:44px;`,
    bar: css`flex:1 1 auto; min-width:2px; background:#335EFF; border-radius:1px;`,
    stat: css`font-family:${mono}; font-size:11px; color:${t.colors.text.secondary}; margin-top:4px;`,
    tbl: css`width:100%; border-collapse:collapse; font-size:12px; font-family:${mono};
      th{text-align:left; color:${t.colors.text.secondary}; font-weight:500; text-transform:uppercase; font-size:10px; letter-spacing:.05em; padding:2px 6px 2px 0;}
      td{padding:2px 8px 2px 0; white-space:nowrap;}`,
    muted: css`color:${t.colors.text.secondary};`,
    compbar: css`margin-bottom:14px;`,
    compHead: css`font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:${t.colors.text.secondary}; margin-bottom:6px;`,
    compGrid: css`display:grid; grid-template-columns:1fr 1fr; gap:20px; @media (max-width:720px){grid-template-columns:1fr;}`,
    compCol: css`display:flex; align-items:baseline; flex-wrap:wrap; gap:14px;`,
    compTag: css`flex:0 0 100%; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:${t.colors.text.secondary};`,
    cv: css`display:flex; align-items:baseline; gap:4px;`,
    cvk: css`font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:${t.colors.text.secondary};`,
    cvv: css`font-size:13px; font-family:${'ui-monospace,Menlo,monospace'}; font-variant-numeric:tabular-nums; font-weight:600;`,
  };
};
