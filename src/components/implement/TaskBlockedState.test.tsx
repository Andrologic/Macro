import { afterEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  getDependencyBlockedMessage,
  TaskBlockedState,
} from './TaskBlockedState';

const t = (
  _key: string,
  fallback: string,
  options?: Record<string, unknown>
): string => fallback.replace(/\{\{(\w+)\}\}/g, (_match, token) => String(options?.[token] ?? ''));

describe('TaskBlockedState', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
  });

  it('formats dependency-blocked task messages', () => {
    expect(getDependencyBlockedMessage(null, t)).toBeNull();
    expect(getDependencyBlockedMessage({ is_blocked: false, blocked_by: ['A'] }, t)).toBeNull();
    expect(getDependencyBlockedMessage({ is_blocked: true, blocked_by: ['A', 'B'] }, t)).toBe('Blocked by: A, B');
    expect(getDependencyBlockedMessage({ is_blocked: true }, t)).toBe('This task is waiting for its prerequisites.');
  });

  it('renders a clear locked state with optional help text', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <TaskBlockedState
          title="Task blocked"
          message="Blocked by: Setup"
          help="Complete the prerequisite tasks first."
        />
      );
    });

    expect(container.textContent).toContain('Task blocked');
    expect(container.textContent).toContain('Blocked by: Setup');
    expect(container.textContent).toContain('Complete the prerequisite tasks first.');
  });
});
