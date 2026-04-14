import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TaskStatusIndicator } from './TaskStatusIndicator';

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

describe('TaskStatusIndicator', () => {
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

  it('renders a fixed dot for idle prompt', async () => {
    await act(async () => {
      root?.render(
        <TaskStatusIndicator
          state="idle_prompt"
          layout="compact"
          className="text-amber-500"
        />
      );
      await flushRender();
    });

    const indicator = document.body.querySelector(
      '[data-task-status-indicator-state="idle_prompt"]'
    );

    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('data-task-status-indicator-layout')).toBe('compact');
    expect(indicator?.querySelector('.task-status-awaiting-response__halo')).toBeNull();
  });

  it('renders a continuous pulse halo for awaiting response', async () => {
    await act(async () => {
      root?.render(
        <TaskStatusIndicator
          state="awaiting_response"
          layout="card"
          className="text-amber-500"
        />
      );
      await flushRender();
    });

    const indicator = document.body.querySelector(
      '[data-task-status-indicator-state="awaiting_response"]'
    );

    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('data-task-status-indicator-layout')).toBe('card');
    expect(indicator?.getAttribute('data-task-status-indicator-pulse')).toBe('awaiting_response');
    expect(indicator?.querySelectorAll('.task-status-awaiting-response__halo').length).toBe(1);
    expect(indicator?.className).toContain('text-amber-500');
  });

  it('renders the spinner for running', async () => {
    await act(async () => {
      root?.render(
        <TaskStatusIndicator
          state="running"
          layout="graph"
          className="text-amber-500"
        />
      );
      await flushRender();
    });

    const indicator = document.body.querySelector(
      '[data-task-status-indicator-state="running"]'
    );

    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('data-task-status-indicator-layout')).toBe('graph');
    expect(indicator?.querySelector('.animate-spin')).not.toBeNull();
  });
});
