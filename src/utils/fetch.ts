import { getBackendSrv } from '@grafana/runtime';
import { PanelData, DataFrame, FieldType, LoadingState } from '@grafana/data';

/** One frame from a /api/ds/query response, as a minimal DataFrame. */
function toFrame(fr: any): DataFrame {
  const fields = (fr?.schema?.fields ?? []).map((f: any, i: number) => ({
    name: f.name,
    type: (f.type as FieldType) ?? FieldType.other,
    config: {},
    values: (fr?.data?.values?.[i] ?? []) as unknown[],
  }));
  const len = fields[0]?.values?.length ?? 0;
  return { fields, length: len } as unknown as DataFrame;
}

/**
 * Run several SQL queries against one datasource in a single /api/ds/query call
 * and return them wrapped as PanelData, so the existing parsers can consume it.
 * Each entry's refId becomes a series; a failed query is dropped (its section
 * then shows empty rather than blanking the whole board).
 */
export async function runQueries(
  dsUid: string,
  fromMs: number,
  toMs: number,
  queries: Array<{ refId: string; sql: string }>
): Promise<{ data: PanelData; errors: Record<string, string> }> {
  const body = {
    from: String(fromMs),
    to: String(toMs),
    queries: queries.map((q) => ({
      refId: q.refId,
      datasource: { uid: dsUid, type: 'grafana-postgresql-datasource' },
      rawSql: q.sql,
      format: 'table',
      intervalMs: 60000,
      maxDataPoints: 2000,
    })),
  };
  const resp: any = await getBackendSrv().post('/api/ds/query', body);
  const series: DataFrame[] = [];
  const errors: Record<string, string> = {};
  for (const q of queries) {
    const r = resp?.results?.[q.refId];
    if (r?.error) { errors[q.refId] = r.error; continue; }
    for (const fr of r?.frames ?? []) { series.push(toFrame(fr)); }
  }
  const data = {
    state: LoadingState.Done,
    series,
    timeRange: {} as any,
  } as unknown as PanelData;
  return { data, errors };
}
