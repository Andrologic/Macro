import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { SpinnerIcon } from './SpinnerIcon';

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

describe('SpinnerIcon', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    container = null;
    root = null;
  });

  it('uses the shared spin animation and inherits caller color classes', async () => {
    await act(async () => {
      root?.render(<SpinnerIcon className="text-primary" />);
      await flushRender();
    });

    const spinner = document.body.querySelector('[data-spinner-icon="true"]');
    const icon = spinner?.querySelector('svg');
    const className = icon?.getAttribute('class') ?? '';
    expect(spinner).not.toBeNull();
    expect(className).toContain('origin-center');
    expect(className).toContain('animate-spin');
    expect(className).toContain('text-primary');
  });

  it('exposes an accessible label when provided', async () => {
    await act(async () => {
      root?.render(<SpinnerIcon label="Loading models" />);
      await flushRender();
    });

    const spinner = document.body.querySelector('[data-spinner-icon="true"]');
    expect(spinner?.getAttribute('role')).toBe('status');
    expect(spinner?.getAttribute('aria-label')).toBe('Loading models');
  });
});
