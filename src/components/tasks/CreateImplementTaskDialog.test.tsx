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
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
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

    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true,
      clientX: 100,
      clientY: 120,
    })));
    const pointerTooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(pointerTooltip?.textContent).toBe(expected.Feature);
    expect(container.contains(pointerTooltip)).toBe(false);
    expect(pointerTooltip?.style.left).toBe('112px');
    expect(pointerTooltip?.style.top).toBe('132px');

    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 180,
      clientY: 200,
    })));
    expect(document.body.querySelector<HTMLElement>('[role="tooltip"]')?.style.left).toBe('192px');
    expect(document.body.querySelector<HTMLElement>('[role="tooltip"]')?.style.top).toBe('212px');

    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    buttons.Hotfix.getBoundingClientRect = () => ({
      left: 120,
      top: 80,
      right: 220,
      bottom: 120,
      width: 100,
      height: 40,
      x: 120,
      y: 80,
      toJSON: () => ({}),
    });
    await act(async () => buttons.Hotfix.focus());
    const focusTooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(focusTooltip?.textContent).toBe(expected.Hotfix);
    expect(focusTooltip?.style.left).toBe('120px');
    expect(focusTooltip?.style.top).toBe('132px');
    await act(async () => {
      buttons.Feature.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        clientX: 180,
        clientY: 200,
      }));
      buttons.Feature.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(expected.Hotfix);
    await act(async () => buttons.Hotfix.blur());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true,
      clientX: 795,
      clientY: 595,
    })));
    const constrainedTooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(constrainedTooltip?.style.left).toBe('463px');
    expect(constrainedTooltip?.style.top).toBe('503px');
    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));

    await act(async () => {
      buttons.Bugfix.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      buttons.Bugfix.click();
      buttons.Bugfix.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector('fieldset > p')).toBeNull();
  });
});
