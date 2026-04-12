import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ActionableNotificationTemplate,
  InformationalNotificationTemplate,
} from './index';

describe('notification templates', () => {
  it('shares the same surface for informational and actionable notifications', () => {
    const informationalMarkup = renderToStaticMarkup(
      <InformationalNotificationTemplate
        tone="info"
        title="Background indexing finished"
        description="Everything is up to date."
      />
    );
    const actionableMarkup = renderToStaticMarkup(
      <ActionableNotificationTemplate
        tone="warning"
        title="Base branch missing"
        description="Choose what to do next."
        actions={[
          { label: 'Create', variant: 'primary' },
          { label: 'Open settings', variant: 'secondary' },
        ]}
        onActionClick={() => undefined}
      />
    );

    expect(informationalMarkup).toContain('data-notification-surface="true"');
    expect(actionableMarkup).toContain('data-notification-surface="true"');
    expect(actionableMarkup).toContain('Create');
    expect(actionableMarkup).toContain('Open settings');
  });

  it('renders actionable snapshots without interactive buttons', () => {
    const snapshotMarkup = renderToStaticMarkup(
      <ActionableNotificationTemplate
        tone="error"
        title="Sync requires attention"
        description="A follow-up step is still needed."
        actions={[
          { label: 'Retry', variant: 'primary' },
          { label: 'Inspect', variant: 'secondary' },
        ]}
        interactive={false}
        snapshotLabel="Action required"
      />
    );

    expect(snapshotMarkup).toContain('data-notification-surface="true"');
    expect(snapshotMarkup).toContain('Action required');
    expect(snapshotMarkup).not.toContain('<button');
  });
});
