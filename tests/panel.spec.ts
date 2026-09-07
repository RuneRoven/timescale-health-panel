import { test, expect } from '@grafana/plugin-e2e';

// Render smoke: the panel mounts and shows its own empty-state prompt when no
// datasource is set. Proves the compiled React component loads and renders —
// the thing the create-plugin migration had to preserve.
test('panel mounts and renders its empty-state', async ({ panelEditPage }) => {
  await panelEditPage.setVisualization('TimescaleDB Health');
  await expect(panelEditPage.panel.locator).toContainText('Pick a');
});
