import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { WorkflowEdge, WorkflowEdgeSummary, type WorkflowEdgeData } from './WorkflowEdge';
import { Dialog } from '../ui/Dialog';

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
const data = (extra: Partial<WorkflowEdgeData> = {}): WorkflowEdgeData => ({
  connection: { id: 'a-b', source: 'a', target: 'b', label: 'true', dependency: false,
    transfers: ['resources.result ← text · text/plain', 'report'] },
  sourceTitle: 'Check quality', targetTitle: 'Publish', focused: false, dismissSignal: 0,
  inspectSource: () => {}, inspectTarget: () => {}, ...extra,
});
async function mount(value = data(), insideDialog = false) {
  if (!host?.isConnected) {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  }
  const edge = <ReactFlowProvider><svg><WorkflowEdge id="a-b" source="a" target="b" sourceX={0} sourceY={0} targetX={0} targetY={100}
    sourcePosition={Position.Bottom} targetPosition={Position.Top} data={value} type="workflow" selected={false} selectable={false} deletable={false} /></svg></ReactFlowProvider>;
  await act(async () => root!.render(insideDialog ? <Dialog title="Workflow" onClose={() => {}}>{edge}</Dialog> : edge));
  return document.querySelector<SVGGElement>('.agsdl-edge-hit')!;
}
const event = async (element: Element, type: string) => act(async () => {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
});
const key = async (element: Element, value: string) => act(async () => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
});

it('explains the route and delivery without exposing generated projection syntax', async () => {
  await mount();
  await act(async () => root!.render(<WorkflowEdgeSummary {...data()} />));
  expect(host.textContent).toContain('If yes');
  expect(host.textContent).toContain('Check quality');
  expect(host.textContent).toContain('Publish');
  expect(host.textContent).toContain('Agent response');
  expect(host.textContent).toContain('report');
  expect(host.textContent).not.toContain('resources.result');
  expect(host.textContent).not.toContain('text/plain');
});

it('does not imply a transfer when only a dependency is declared, and preserves custom branch names', async () => {
  await mount();
  await act(async () => root!.render(<WorkflowEdgeSummary {...data({ connection: { id: 'a-b', source: 'a', target: 'b', label: 'dependency', dependency: true } })} />));
  expect(host.textContent).toContain('No data transfer is declared');
  expect(host.querySelector('.agsdl-edge-payloads')).toBeNull();
  await act(async () => root!.render(<WorkflowEdgeSummary {...data({ connection: { id: 'a-b', source: 'a', target: 'b', label: 'needs-review', dependency: false } })} />));
  expect(host.textContent).toContain('needs-review');
  expect(host.querySelector('.agsdl-edge-payloads')).toBeNull();
});

it('distinguishes approval, rejection, recovery and data-only exchanges', async () => {
  await mount();
  for (const [label, heading] of [['false', 'If no'], ['approved', 'After approval'], ['denied', 'If denied'], ['onError', 'On error'], ['payloadTitle', 'If “payloadTitle”']]) {
    await act(async () => root!.render(<WorkflowEdgeSummary {...data({ connection: { id: 'a-b', source: 'a', target: 'b', label, dependency: false } })} />));
    expect(host.querySelector('header')?.textContent).toBe(heading);
  }
  await act(async () => root!.render(<WorkflowEdgeSummary {...data({ connection: { id: 'a-b', source: 'a', target: 'b', label: 'exchange', dependency: false, exchangeOnly: true, transfers: ['Message'] } })} />));
  expect(host.textContent).toContain('without triggering the block');
  expect(host.querySelector('.agsdl-edge-payloads')?.textContent).toBe('Message');
});

it('opens a delayed preview and pins it on click without navigating or executing', async () => {
  let actions = 0;
  const focus: boolean[] = [];
  const edge = await mount(data({ focusEdge: (_, open) => focus.push(open), inspect: () => { actions++; }, inspectSource: () => { actions++; } }));
  await act(async () => {
    edge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 430));
  });
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Agent response');
  await event(edge, 'click');
  await act(async () => {
    edge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await new Promise(resolve => setTimeout(resolve, 180));
  });
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  expect(actions).toBe(0);
  expect(focus.at(-1)).toBe(true);
  await key(edge, 'Escape');
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(focus.at(-1)).toBe(false);
});

it('keeps its context menu usable inside an expanded graph and opens the exact endpoint', async () => {
  const visited: string[] = [];
  const edge = await mount(data({ inspectSource: () => visited.push('a'), inspectTarget: () => visited.push('b') }), true);
  await act(async () => edge.focus());
  await key(edge, 'ContextMenu');
  expect(document.querySelector('[role="menu"]')?.hasAttribute('inert')).toBe(false);
  expect(document.activeElement?.textContent).toBe('View source block');
  await key(document.activeElement!, 'ArrowDown');
  expect(document.activeElement?.textContent).toBe('View destination block');
  await event(document.activeElement!, 'click');
  expect(visited).toEqual(['b']);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

it('dismisses pinned previews on graph movement and only closes its popup on Escape', async () => {
  let edge = await mount(data(), true);
  await key(edge, 'Enter');
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await key(edge, 'Escape');
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await key(edge, 'Enter');
  edge = await mount(data({ dismissSignal: 1 }), true);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(edge.isConnected).toBe(true);
});
