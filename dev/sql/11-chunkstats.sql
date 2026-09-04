-- ============================================================
-- 02_chunk_stats.sql -- compression numbers per chunk, across TimescaleDB versions
--
-- WHY THIS EXISTS: row-level compression figures (how many rows a chunk held
-- before compression, and therefore bytes per row) are only in
-- `_timescaledb_catalog.compression_chunk_size`. That is an INTERNAL catalog,
-- and its join key moved:
--
--   TimescaleDB <= ~2.19   _timescaledb_catalog.chunk (id, schema_name, table_name, ...)
--   TimescaleDB 2.2x+      _timescaledb_catalog.chunk (id, relid, ...)
--
-- A dashboard that joins on `schema_name` therefore dies with
-- `column cat.schema_name does not exist` after a routine upgrade -- one panel
-- at a time, in production, with no warning. Pinning the query to one version
-- just moves which customer it breaks at.
--
-- So the version check happens ONCE, here, at install time, and the dashboard
-- reads a view with a stable shape. Re-run this file after a TimescaleDB major
-- upgrade; it is idempotent.
--
-- The supported alternatives (`chunk_compression_stats()`,
-- `hypertable_compression_stats()`) are version-stable but report only BYTES,
-- never rows -- which is exactly the column the storage-planning panels need.
-- Hence the internal catalog, wrapped rather than sprinkled through 3 panels.
--
--   psql -h HOST -U USER -d DATABASE -v ON_ERROR_STOP=1 -f sql/02_chunk_stats.sql
-- ============================================================

DO $$
DECLARE
    v_has_relid BOOLEAN;
    v_join      TEXT;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = '_timescaledb_catalog'
           AND table_name   = 'chunk'
           AND column_name  = 'relid'
    ) INTO v_has_relid;

    -- Both forms resolve a chunk row to its (schema, name); only the source
    -- columns differ.
    IF v_has_relid THEN
        v_join := 'SELECT ch.id,
                          n.nspname::TEXT  AS chunk_schema,
                          cl.relname::TEXT AS chunk_name,
                          ch.hypertable_id
                     FROM _timescaledb_catalog.chunk ch
                     JOIN pg_class cl     ON cl.oid = ch.relid
                     JOIN pg_namespace n  ON n.oid = cl.relnamespace';
    ELSE
        v_join := 'SELECT ch.id,
                          ch.schema_name::TEXT AS chunk_schema,
                          ch.table_name::TEXT  AS chunk_name,
                          ch.hypertable_id
                     FROM _timescaledb_catalog.chunk ch';
    END IF;

    EXECUTE format($fmt$
        CREATE OR REPLACE VIEW chunk_compression_detail AS
        WITH ch AS (%s)
        SELECT ht.schema_name::TEXT AS hypertable_schema,
               ht.table_name::TEXT  AS hypertable_name,
               ch.chunk_schema,
               ch.chunk_name,
               ccs.numrows_pre_compression   AS rows_before,
               ccs.numrows_post_compression  AS rows_after,
               (ccs.uncompressed_heap_size + ccs.uncompressed_toast_size
                + ccs.uncompressed_index_size)::BIGINT AS bytes_before,
               (ccs.compressed_heap_size + ccs.compressed_toast_size
                + ccs.compressed_index_size)::BIGINT   AS bytes_after
          FROM ch
          JOIN _timescaledb_catalog.compression_chunk_size ccs ON ccs.chunk_id = ch.id
          JOIN _timescaledb_catalog.hypertable ht ON ht.id = ch.hypertable_id
    $fmt$, v_join);

    RAISE NOTICE '02: chunk_compression_detail built (chunk.relid present: %)', v_has_relid;
END $$;

COMMENT ON VIEW chunk_compression_detail IS
    'Per-chunk compression figures with a stable shape across TimescaleDB '
    'versions: rows and bytes before and after. Only COMPRESSED chunks appear -- '
    'an uncompressed chunk has no row here, which is why every consumer '
    'aggregates with COALESCE and treats missing as zero. Rebuild after a '
    'TimescaleDB major upgrade by re-running sql/02_chunk_stats.sql.';

-- ---- a hypertable-level roll-up, since all three panels wanted one --------
CREATE OR REPLACE VIEW hypertable_compression_detail AS
SELECT hypertable_schema,
       hypertable_name,
       count(*)                          AS compressed_chunks,
       COALESCE(sum(rows_before), 0)     AS rows_compressed,
       COALESCE(sum(bytes_before), 0)    AS bytes_before,
       COALESCE(sum(bytes_after), 0)     AS bytes_after,
       CASE WHEN COALESCE(sum(bytes_after), 0) > 0
            THEN round(sum(bytes_before)::NUMERIC / sum(bytes_after), 1) END AS ratio
  FROM chunk_compression_detail
 GROUP BY 1, 2;

COMMENT ON VIEW hypertable_compression_detail IS
    'Compression totals per hypertable. A hypertable with no compressed chunk '
    'is ABSENT rather than reported as zero -- "not compressed yet" and '
    '"compressed to nothing" are different facts.';

DO $$
DECLARE
    v_reader TEXT := 'umh_grafana_reader';    -- EDIT PER SITE
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_reader) THEN
        EXECUTE format('GRANT SELECT ON chunk_compression_detail,
                                        hypertable_compression_detail TO %I', v_reader);
    ELSE
        RAISE WARNING 'role % does not exist -- grant SELECT on '
                      'chunk_compression_detail and hypertable_compression_detail '
                      'to your Grafana datasource role by hand', v_reader;
    END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '02_chunk_stats.sql applied'; END $$;
