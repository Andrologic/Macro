import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TodoStatusIcon } from './TodoStatusIcon';

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

describe('TodoStatusIcon', () => {
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

  it('animates the in-progress icon', async () => {
    await act(async () => {
      root?.render(<TodoStatusIcon status="in-progress" />);
      await flushRender();
    });

    const icon = document.body.querySelector('[data-todo-status-icon="in-progress"]');
    expect(icon).not.toBeNull();
    expect(icon?.querySelector('.animate-spin')).not.toBeNull();
  });

  it('uses stable themed indicators for done and pending states', async () => {
    await act(async () => {
      root?.render(
        <div>
          <TodoStatusIcon status="done" />
          <TodoStatusIcon status="pending" />
        </div>
      );
      await flushRender();
    });

    expect(document.body.querySelector('[data-todo-status-icon="done"]')).not.toBeNull();
    expect(document.body.querySelector('[data-todo-status-icon="pending"]')).not.toBeNull();
    expect(document.body.querySelector('[data-todo-status-icon="done"]')?.className).toContain(
      'text-emerald-500'
    );
    expect(document.body.querySelector('[data-todo-status-icon="pending"]')?.className).toContain(
      'text-muted-foreground'
    );
  });
});

