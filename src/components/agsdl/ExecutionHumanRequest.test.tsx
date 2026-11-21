import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExecutionHumanRequest, type ExecutionHumanAnswer, type ExecutionHumanRequestView } from './ExecutionHumanRequest';

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; });
const labels = { choice: 'Choice', comment: 'Comment', answer: 'Answer', submit: 'Send', approve: 'Approve', reject: 'Reject', failed: 'Request changed' };
async function render(request: ExecutionHumanRequestView, onAnswer: (answer: ExecutionHumanAnswer) => Promise<void>, open = true) {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root!.render(<ExecutionHumanRequest request={request} labels={labels} open={open} onAnswer={onAnswer} />));
}

it('retains an approval draft after a conflict and does not submit a removed choice', async () => {
  const answers: ExecutionHumanAnswer[] = [];
  const answer = async (value: ExecutionHumanAnswer) => { answers.push(value); throw new Error('conflict'); };
  const request: ExecutionHumanRequestView = { kind: 'approval', title: 'Review', message: 'Input', choices: [{ value: 'continue', label: 'Continue' }] };
  await render(request, answer);
  const select = host.querySelector('select')!;
  await act(async () => { select.value = '0'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const textarea = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep this draft');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(answers).toEqual([{ kind: 'approval', choice: 'continue', comment: 'Keep this draft' }]);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Request changed');
  await render({ ...request, choices: [{ value: 'stop', label: 'Stop' }] }, answer);
  expect(host.querySelector('textarea')!.value).toBe('Keep this draft');
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  await render(request, answer, false);
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(host.querySelector('textarea')!.readOnly).toBe(true);
  expect(host.querySelector('textarea')!.value).toBe('Keep this draft');
});

it('sends a plan refusal independently from approval choices', async () => {
  const answers: ExecutionHumanAnswer[] = [];
  await render({ kind: 'plan', title: 'Plan', message: 'Steps' }, async value => { answers.push(value); });
  await act(async () => host.querySelectorAll('button')[1].click());
  expect(answers).toEqual([{ kind: 'plan', approve: false, comment: '' }]);
});

it('submits a plan decision only once while a response is pending', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const answers: ExecutionHumanAnswer[] = [];
  await render({ kind: 'plan', title: 'Plan', message: 'Steps' }, async value => { answers.push(value); await pending; });
  const button = host.querySelector('button')!;
  await act(async () => { button.click(); button.click(); });
  expect(answers).toEqual([{ kind: 'plan', approve: true, comment: '' }]);
  await act(async () => { release(); await pending; });
});

it('requires an explicit selection even when an arbitrary flow choice is the empty string', async () => {
  const answers: ExecutionHumanAnswer[] = [];
  await render({ kind: 'approval', title: 'Choose', message: 'Exact message', choices: [{ value: '', label: '' }] }, async answer => { answers.push(answer); });
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  await act(async () => { const select = host.querySelector('select')!; select.value = '0'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(answers).toEqual([{ kind: 'approval', choice: '', comment: '' }]);
});
