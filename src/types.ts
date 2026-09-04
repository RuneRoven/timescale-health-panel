/** TimescaleDB Health panel — options + parsed row shapes (parity with the
 *  timescale-metrics dashboard). */

export interface TimescaleOptions {
  /** uid of the Postgres/TimescaleDB datasource the panel queries. */
  datasourceUid?: string;
  /** No write for longer than this => the hypertable reads STALE (red). */
  staleMinutes: number;
  /** Disk size in GB, for the storage projection. 0 hides the projection bar. */
  diskGb: number;
  /** size | freshness | name */
  sortBy: 'size' | 'freshness' | 'name';
  /** Comma-separated schemas to leave off the board. */
  hideSchemas: string;
  showHeader: boolean;
  showProjection: boolean;
  showRegular: boolean;
  showJobs: boolean;
  showSizes: boolean;
  /** Colour scheme for the bar charts (sizes, regular tables, projection). */
  barColorScheme: 'brand' | 'sequential' | 'state' | 'green' | 'neutral' | 'classic';
}

export const defaults: TimescaleOptions = {
  datasourceUid: undefined,
  staleMinutes: 30,
  diskGb: 100,
  sortBy: 'size',
  hideSchemas: '',
  showHeader: true,
  showProjection: true,
  showRegular: true,
  showJobs: true,
  showSizes: true,
  barColorScheme: 'brand',
};

export interface Hypertable {
  schema: string;
  name: string;
  lastWrite: number | null;
  sizeBytes: number;
  compressedBytes: number;
  ratio: number | null;
  rows: number | null;
  compRows: number | null;
  chunks: number;
  compressedChunks: number;
  compressionEnabled: boolean;
  compressAfter: string | null;   // pg interval text
  dropAfter: string | null;       // retention, pg interval text
  oldest: number | null;          // epoch ms
  newest: number | null;          // epoch ms
  bytesPerDay: number | null;
  tscol: string | null;
  tscolIsTime: boolean;
}

export interface Summary {
  dbSizeBytes: number | null;
  hypertables: number | null;
  chunksTotal: number | null;
  chunksCompressed: number | null;
  failedJobs: number | null;
  cacheHitPct: number | null;
  commits: number | null;
  tuplesInserted: number | null;
  walBytes: number | null;
}

export interface RegularTable { name: string; sizeBytes: number; }

export interface Job {
  id: number | null;
  name: string;
  hypertable: string;
  every: string;
  status: string;          // Success | Failed | Scheduled | Running
  lastSuccess: number | null;
  nextStart: number | null;
  totalRuns: number | null;
}

export type Tone = 'ok' | 'warn' | 'stale' | 'idle';
