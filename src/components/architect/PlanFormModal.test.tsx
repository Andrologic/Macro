import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlanFormModal } from './PlanFormModal';

let root: Root | null = null;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  document.body.innerHTML = '';
});

describe('PlanFormModal', () => {
  it('names the dialog and field, confines focus and restores the trigger on Escape', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const Fixture = () => {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Rename</button>{open &&
        <PlanFormModal title="Rename plan" description="Choose a name" initialValue="Plan" onConfirm={() => undefined} onClose={() => setOpen(false)} />}</>;
    };
    await act(async () => { root!.render(<Fixture />); });
    const trigger = container.querySelector('button')!;
    trigger.focus();
    await act(async () => { trigger.click(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Rename plan');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('Choose a name');
    const input = dialog.querySelector('input')!;
    expect(document.activeElement).toBe(input);
    expect(dialog.querySelector('label')?.htmlFor).toBe(input.id);
    expect(input.id).toBeTruthy();
    const buttons = dialog.querySelectorAll('button');
    expect(buttons[0].getAttribute('aria-label')).toBeTruthy();
    buttons[2].focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[2]);
    expect(container.hasAttribute('inert')).toBe(true);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps required-name validation, trims submissions and blocks submission and dismissal while loading', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const confirm = mock(() => undefined);
    const close = mock(() => undefined);
    const render = async (initialValue: string, isLoading = false, isCanonicalPlan = false) => {
      await act(async () => { root!.render(<PlanFormModal key={initialValue} initialValue={initialValue} isLoading={isLoading} isCanonicalPlan={isCanonicalPlan} onConfirm={confirm} onClose={close} />); });
    };
    const submit = async () => { await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };
    await render('  ');
    await submit();
    expect(confirm).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    await render('  New plan  ');
    await submit();
    expect(confirm).toHaveBeenLastCalledWith('New plan');
    confirm.mockClear();
    await render('Busy', true);
    await submit();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(confirm).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await render('', false, true);
    await submit();
    expect(confirm).toHaveBeenCalledWith('');
  });
});
