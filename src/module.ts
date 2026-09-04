import { PanelPlugin } from '@grafana/data';
import { TimescaleOptions, defaults } from './types';
import { TimescaleHealthPanel } from './components/TimescaleHealthPanel';
import { DsPicker } from './components/DsPicker';

export const plugin = new PanelPlugin<TimescaleOptions>(TimescaleHealthPanel).setPanelOptions((builder) =>
  builder
    // The panel runs its own SQL against this datasource -- the dashboard needs
    // no queries, and the user never sees SQL.
    .addCustomEditor({
      id: 'datasourceUid', path: 'datasourceUid', name: 'Data source',
      description: 'PostgreSQL / TimescaleDB connection the panel reads from.',
      editor: DsPicker as any, defaultValue: defaults.datasourceUid, category: ['Connection'],
    })
    .addNumberInput({
      path: 'staleMinutes', name: 'Stale after (minutes)',
      description: 'No write for longer than this => the hypertable reads stale (red).',
      defaultValue: defaults.staleMinutes, settings: { min: 1, max: 1440, step: 1, integer: true }, category: ['Health'],
    })
    .addNumberInput({
      path: 'diskGb', name: 'Disk size (GB)',
      description: 'Volume size for the storage projection. 0 hides it.',
      defaultValue: defaults.diskGb, settings: { min: 0, max: 100000, step: 10, integer: true }, category: ['Storage'],
    })
    .addRadio({
      path: 'sortBy', name: 'Sort hypertables by', defaultValue: defaults.sortBy,
      settings: { options: [{ value: 'size', label: 'Size' }, { value: 'freshness', label: 'Freshness' }, { value: 'name', label: 'Name' }] },
      category: ['Layout'],
    })
    .addTextInput({
      path: 'hideSchemas', name: 'Hide schemas',
      description: 'Comma-separated schema names to leave off the board.',
      defaultValue: defaults.hideSchemas, category: ['Layout'],
    })
    .addSelect({
      path: 'barColorScheme', name: 'Bar colour scheme',
      description: 'Colour for the size and regular-table bars.',
      defaultValue: defaults.barColorScheme,
      settings: { options: [
        { value: 'brand', label: 'Brand blue' },
        { value: 'sequential', label: 'Blue ramp (by size)' },
        { value: 'state', label: 'By freshness state' },
        { value: 'green', label: 'Green' },
        { value: 'neutral', label: 'Neutral grey' },
        { value: 'classic', label: 'Classic (green-red spectrum)' },
      ] }, category: ['Layout'],
    })
    .addBooleanSwitch({ path: 'showHeader', name: 'Summary header', defaultValue: defaults.showHeader, category: ['Sections'] })
    .addBooleanSwitch({ path: 'showProjection', name: 'Storage projection', defaultValue: defaults.showProjection, category: ['Sections'] })
    .addBooleanSwitch({ path: 'showSizes', name: 'Hypertable sizes', defaultValue: defaults.showSizes, category: ['Sections'] })
    .addBooleanSwitch({ path: 'showRegular', name: 'Largest regular tables', defaultValue: defaults.showRegular, category: ['Sections'] })
    .addBooleanSwitch({ path: 'showJobs', name: 'Background jobs', defaultValue: defaults.showJobs, category: ['Sections'] })
);
