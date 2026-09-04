-- ============================================================
-- 01_freshness.sql -- "when did each hypertable last receive a row?"
--
-- The one question in this dashboard that plain SQL cannot answer. Every other
-- panel reads a catalog; freshness has to read the DATA, and the time column is
-- named differently in every hypertable -- so it needs dynamic SQL, so it needs
-- a function.
--
-- It is also the panel worth having. Catalog panels tell you the database is
-- healthy; this one tells you the INGEST is healthy, which is the failure
-- everybody actually hits: a bridge dies, nothing errors anywhere, and the data
-- simply stops while every size and compression panel still looks perfect.
--
--   psql -h HOST -U USER -d DATABASE -v ON_ERROR_STOP=1 -f sql/01_freshness.sql
--
-- COST: one `SELECT max(<time col>)` per hypertable. On a hypertable with a
-- descending index on the time column -- which every hypertable has -- that is
-- an index lookup on the newest chunk, not a scan. Fine to refresh on a
-- dashboard timer; not something to call per row.
-- ============================================================

CREATE OR REPLACE FUNCTION hypertable_freshness()
RETURNS TABLE(
    hypertable_schema TEXT,
    hypertable_name   TEXT,
    time_column       TEXT,
    last_write        TIMESTAMPTZ
) AS $$
DECLARE
    r  RECORD;
    ts TIMESTAMPTZ;
BEGIN
    FOR r IN
        SELECT d.hypertable_schema, d.hypertable_name, d.column_name, d.column_type
          FROM timescaledb_information.dimensions d
         WHERE d.dimension_number = 1
         ORDER BY 1, 2
    LOOP
        -- Only time-typed dimensions have a meaningful "last write". A
        -- hypertable partitioned on an integer sequence is skipped rather than
        -- reported with a nonsense timestamp.
        CONTINUE WHEN r.column_type NOT IN
            ('timestamp with time zone', 'timestamp without time zone', 'date');

        BEGIN
            EXECUTE format('SELECT max(%I)::timestamptz FROM %I.%I',
                           r.column_name, r.hypertable_schema, r.hypertable_name)
               INTO ts;
        EXCEPTION WHEN insufficient_privilege OR undefined_table THEN
            -- A reader without rights on one hypertable must not blank the whole
            -- panel: report the table with a NULL timestamp, which the dashboard
            -- already sorts to the top as "unknown age".
            ts := NULL;
        END;

        hypertable_schema := r.hypertable_schema;
        hypertable_name   := r.hypertable_name;
        time_column       := r.column_name;
        last_write        := ts;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION hypertable_freshness() IS
    'Last written timestamp per hypertable, found through its primary time '
    'dimension. NULL means the table is empty or unreadable by the caller. '
    'Not SECURITY DEFINER on purpose: freshness of a table you may not read is '
    'not information this dashboard should hand out.';

-- Grant to whichever role the Grafana datasource uses.
DO $$
DECLARE
    v_reader TEXT := 'umh_grafana_reader';    -- EDIT PER SITE
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_reader) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION hypertable_freshness() TO %I', v_reader);
    ELSE
        RAISE WARNING 'role % does not exist -- grant hypertable_freshness() to '
                      'your Grafana datasource role by hand', v_reader;
    END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '01_freshness.sql applied'; END $$;
