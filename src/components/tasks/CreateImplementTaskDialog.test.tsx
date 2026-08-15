import React from 'react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

mock.module('../ui/Dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { CreateImplementTaskDialog } from './CreateImplementTaskDialog';

describe('CreateImplementTaskDialog task type help', () => {
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

  it('describes every available task type for pointer and keyboard users', async () => {
    await act(async () => {
      root.render(
        <CreateImplementTaskDialog
          projects={[]}
          initialProjectId={null}
          isCreating={false}
          onClose={() => undefined}
          onCreate={() => undefined}
        />
      );
    });

    const expected = {
      Feature: 'Feature creates a branch from the configured development branch and merges it back into that branch.',
      Bugfix: 'Bugfix creates a branch from the configured development branch and merges it back into that branch.',
      Hotfix: 'Hotfix creates a branch from the configured production branch and merges it back into that branch.',
    };

    for (const [label, description] of Object.entries(expected)) {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim().startsWith(label)
      );
      expect(button, label).toBeDefined();

      const descriptionId = button?.getAttribute('aria-describedby');
      expect(descriptionId, `${label} keyboard description`).toBeTruthy();
      expect(container.querySelector(`#${descriptionId}`)?.textContent).toBe(description);
    }

    const buttons = Object.fromEntries(
      Object.keys(expected).map((label) => [
        label,
        Array.from(container.querySelectorAll('button')).find(
          (candidate) => candidate.textContent?.trim() === label
        ) as HTMLButtonElement,
      ])
    );

    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe(expected.Feature);
    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => buttons.Hotfix.focus());
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe(expected.Hotfix);
    await act(async () => buttons.Hotfix.blur());
    expect(container.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      buttons.Bugfix.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      buttons.Bugfix.click();
      buttons.Bugfix.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector('fieldset > p')).toBeNull();
  });
});
