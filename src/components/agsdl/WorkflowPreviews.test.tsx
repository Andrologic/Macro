import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkflowBlockPreview, WorkflowEdgePreview } from './WorkflowPreviews';

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
async function render(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

it('lists configuration rows in order and keeps expressions literal', async () => {
  const view = await render(<WorkflowBlockPreview details={[
    { key: 'instructions', values: ['Review the change.'] },
    { key: 'test', values: ['data.exitCode = 0'] },
    { key: 'effect', values: ['unknown'] },
  ]} />);
  expect(view.querySelector('.agsdl-preview-lead')?.textContent).toBe('Review the change.');
  const rows = [...view.querySelectorAll('.agsdl-preview-list > div')];
  expect(rows).toHaveLength(2);
  expect(rows[0].querySelector('dd')?.className).toBe('is-literal');
  expect(rows[0].textContent).toContain('data.exitCode = 0');
});

it('describes a connection by the choice that takes it, without naming its target', async () => {
  const view = await render(<WorkflowEdgePreview sourceTitle="Review" sourcePerformer="Reviewer"
    connection={{ id: 'e', source: 'review', target: 'publish', label: 'accept', dependency: false, transfers: ['completion'] }} />);
  expect(view.textContent).toContain('Reviewer');
  expect(view.textContent).toContain('accept');
  expect(view.textContent).not.toContain('publish');
});
