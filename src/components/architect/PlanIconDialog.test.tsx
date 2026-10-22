import { afterEach, expect, test, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlanIconDialog } from './PlanIconDialog';
import { PLAN_ICONS } from '../../services/planIcon';

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

test('offers named choices, marks the current icon and allows selection and reset without a form', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const select = mock(() => undefined);
  const render = async (isLoading = false) => {
    await act(async () => root!.render(<PlanIconDialog value="shield" isLoading={isLoading} error={null} onSelect={select} onClose={() => undefined} />));
  };
  await render();
  const dialog = document.querySelector('[role="dialog"]')!;
  const choices = dialog.querySelectorAll<HTMLButtonElement>('button[aria-pressed]');
  expect(choices).toHaveLength(PLAN_ICONS.length);
  expect([...choices].every(button => Boolean(button.getAttribute('aria-label')))).toBe(true);
  expect(choices[PLAN_ICONS.indexOf('shield')].getAttribute('aria-pressed')).toBe('true');
  await act(async () => choices[PLAN_ICONS.indexOf('workflow')].click());
  expect(select).toHaveBeenLastCalledWith('workflow');
  await act(async () => dialog.querySelector<HTMLButtonElement>('footer button')!.click());
  expect(select).toHaveBeenLastCalledWith(null);
  await render(true);
  expect([...dialog.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true);
});
