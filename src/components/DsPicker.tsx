import React from 'react';
import { StandardEditorProps } from '@grafana/data';
import { DataSourcePicker } from '@grafana/runtime';

/** Custom option editor: pick the Postgres/TimescaleDB datasource the panel
 *  queries. Stored as the datasource uid, so the panel needs no dashboard query. */
export const DsPicker: React.FC<StandardEditorProps<string>> = ({ value, onChange }) => {
  return (
    <DataSourcePicker
      current={value || null}
      filter={(ds) => ds.type === 'grafana-postgresql-datasource'}
      noDefault={false}
      onChange={(ds) => onChange(ds.uid)}
    />
  );
};
