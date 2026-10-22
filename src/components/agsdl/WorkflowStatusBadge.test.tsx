import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { NativeCardActivation, NativeCardState } from '../../services/agsdl/executionView';
import type { TaskStatusIndicatorState } from '../../services/taskStatusPresentation';
import { WorkflowStatusBadge } from './WorkflowStatusBadge';

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
const native = (state: NativeCardState): NativeCardActivation => ({ state, activations: [] });
async function render(state?: TaskStatusIndicatorState, activity?: NativeCardActivation) {
  if (!root || !host?.isConnected) {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  }
  await act(async () => root!.render(<WorkflowStatusBadge
    task={state ? { taskId: 'task', title: 'Review the dossier', state } : undefined}
    native={activity}
  />));
  return host.querySelector('[data-task-status-indicator-state]')?.getAttribute('data-task-status-indicator-state');
}

it('keeps a pending reply or review visible after the native step completes', async () => {
  expect(await render('awaiting_response', native('completed'))).toBe('awaiting_response');
  expect(host.querySelector('[data-task-status-indicator-pulse]')).not.toBeNull();
  expect(await render('in_review', native('completed'))).toBe('in_review');
  expect(host.querySelector('[role="img"]')?.getAttribute('title')).toContain('Review the dossier');
  expect(await render('completed', native('completed'))).toBe('completed');
});

it('uses the shared task badges for native steps without task links', async () => {
  for (const [activity, expected] of Object.entries({ queued: 'idle_prompt', active: 'running', completed: 'completed', failed: 'failed', approval: 'awaiting_response' })) {
    expect(await render(undefined, native(activity as NativeCardState))).toBe(expected);
  }
});

it('does not mask native approvals, failures, Stop or uncertainty with an older task state', async () => {
  expect(await render('completed', native('approval'))).toBe('awaiting_response');
  expect(await render('completed', native('failed'))).toBe('failed');
  for (const state of ['uncertain', 'stopRequested', 'stopped'] as const) {
    expect(await render('completed', native(state))).toBeUndefined();
    expect(host.querySelector('[role="img"]')?.className).toContain(`agsdl-native-status-${state}`);
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBeTruthy();
  }
  expect(await render('completed', { ...native('completed'), partial: true })).toBeUndefined();
  expect(host.querySelector('[role="img"]')?.className).toContain('agsdl-native-status-partial');
});

it('does not invent a status for an unexecuted card', async () => {
  expect(await render()).toBeUndefined();
  expect(host.querySelector('[role="img"]')).toBeNull();
});
