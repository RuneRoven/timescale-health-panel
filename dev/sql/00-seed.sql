-- dev seed: a handful of hypertables with distinct health states, so the panel
-- shows green / yellow / red / grey at once.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 1) metrics: fresh + compressed  -> green, ratio shown
CREATE TABLE metrics(ts timestamptz NOT NULL, device int, tag text, v double precision);
SELECT create_hypertable('metrics','ts',chunk_time_interval=>INTERVAL '6 hours');
INSERT INTO metrics SELECT now() - (g*INTERVAL '1 minute'), g%8, 'temperature', random()*100
  FROM generate_series(1,4000) g;
ALTER TABLE metrics SET (timescaledb.compress, timescaledb.compress_segmentby='device', timescaledb.compress_orderby='ts DESC');
SELECT compress_chunk(c,true) FROM show_chunks('metrics', older_than=>INTERVAL '12 hours') c;

-- 2) events: fresh, compression ENABLED but nothing compressed yet -> yellow "pending"
CREATE TABLE events(ts timestamptz NOT NULL, kind text, payload text);
SELECT create_hypertable('events','ts',chunk_time_interval=>INTERVAL '1 day');
INSERT INTO events SELECT now() - (g*INTERVAL '2 minutes'), 'evt', 'x' FROM generate_series(1,1500) g;
ALTER TABLE events SET (timescaledb.compress, timescaledb.compress_orderby='ts DESC');

-- 3) archive: last write 3 days ago -> STALE red
CREATE TABLE archive(ts timestamptz NOT NULL, note text);
SELECT create_hypertable('archive','ts',chunk_time_interval=>INTERVAL '1 day');
INSERT INTO archive SELECT now() - INTERVAL '3 days' - (g*INTERVAL '5 minutes'), 'old' FROM generate_series(1,600) g;

-- 4) audit: fresh, small, no compression -> green, compress 'off'
CREATE TABLE audit(ts timestamptz NOT NULL, who text, action text);
SELECT create_hypertable('audit','ts',chunk_time_interval=>INTERVAL '1 day');
INSERT INTO audit SELECT now() - (g*INTERVAL '30 seconds'), 'demo', 'login' FROM generate_series(1,400) g;

ANALYZE;
