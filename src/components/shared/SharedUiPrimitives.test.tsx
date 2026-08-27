import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FormField } from './FormField';
import { PanelEmptyState } from './PanelEmptyState';
import { SettingsEmptyState } from './SettingsEmptyState';
import { SettingsStatusBadge } from './SettingsStatusBadge';

describe('shared UI primitives', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('associates a field label and validation messages with its control', async () => {
    await act(async () => {
      root.render(
        <FormField
          label="Project name"
          htmlFor="project-name"
          description="Shown in the project switcher."
          error="Project name is required."
          required
        >
          <input id="project-name" />
        </FormField>,
      );
    });

    const input = container.querySelector('input');
    const label = container.querySelector('label');
    const error = container.querySelector('[role="alert"]');

    expect(label?.getAttribute('for')).toBe('project-name');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toContain('description');
    expect(input?.getAttribute('aria-describedby')).toContain('error');
    expect(error?.textContent).toBe('Project name is required.');
    expect(container.querySelector('[data-form-field="true"]')?.getAttribute('data-invalid')).toBe('true');
  });

  it('keeps panel empty states compact without losing their content', async () => {
    await act(async () => {
      root.render(
        <PanelEmptyState
          compact
          icon="strategy"
          title="No strategy yet"
          description="Select a plan to get started."
          action={<button type="button">Select a plan</button>}
        />,
      );
    });

    const state = container.querySelector('[data-empty-state="panel"]');
    expect(state).not.toBeNull();
    expect(state?.textContent).toContain('No strategy yet');
    expect(state?.textContent).toContain('Select a plan to get started.');
    expect(state?.querySelector('button')?.textContent).toBe('Select a plan');
    expect(state?.className).toContain('py-6');
  });

  it('supports plain and card settings empty states', async () => {
    await act(async () => {
      root.render(
        <SettingsEmptyState
          variant="plain"
          title="No providers"
          description="Add a provider before configuring models."
        />,
      );
    });

    const state = container.querySelector('[data-empty-state="settings"]');
    expect(state?.textContent).toContain('No providers');
    expect(state?.textContent).toContain('Add a provider before configuring models.');
    expect(state?.className).not.toContain('border-dashed');
  });

  it('uses a stable status vocabulary and exposes the selected status', async () => {
    await act(async () => {
      root.render(<SettingsStatusBadge status="warning" label="API key required" />);
    });

    const badge = container.querySelector('[data-settings-status-badge="true"]');
    expect(badge?.getAttribute('data-status')).toBe('warning');
    expect(badge?.textContent).toContain('API key required');
    expect(badge?.querySelector('span')).not.toBeNull();
  });
});
