import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkflowBlockOverlay, WorkflowBlockSummary } from './WorkflowBlockOverlay';
import { WorkflowGraphPopup, type GraphPopupAction } from './WorkflowGraphPopup';
import { Dialog } from '../ui/Dialog';
import { projectViewer } from '../../services/agsdl/viewer';
import { createExample } from '../../services/agsdl/examples';

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
const card = projectViewer(createExample('release')).graphs[0].cards[0];
const actions = (run = () => {}): GraphPopupAction[] => [
  { label: 'Details', icon: null, run }, { label: 'Open task', icon: null, run },
];
async function mount({ insideDialog = false, run = () => {}, dismissSignal = 0 } = {}) {
  if (!host?.isConnected) {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  }
  const block = <WorkflowBlockOverlay card={card} title="Release checklist" kindLabel="Agent"
    incoming={['Initial brief']} outgoing={['PR review']} actions={actions(run)} dismissSignal={dismissSignal}
    task={{ taskId: 'checklist', title: 'Release checklist', state: 'awaiting_response' }}>
    <button>Release checklist</button>
  </WorkflowBlockOverlay>;
  let closes = 0;
  await act(async () => root!.render(insideDialog
    ? <Dialog title="Workflow" onClose={() => { closes++; }}>{block}</Dialog> : block));
  return { block: host.querySelector('button') ?? document.querySelector<HTMLButtonElement>('[role="dialog"] button')!, closes: () => closes };
}
const key = async (value: string, shiftKey = false) => act(async () => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
});
const hover = async (target: HTMLElement) => act(async () => {
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 480));
});

it('shows a delayed summary with its state and neighboring blocks, then dismisses on Escape', async () => {
  const { block } = await mount();
  await hover(block);
  const preview = document.querySelector('[role="tooltip"]');
  expect(preview?.textContent).toContain('Release checklist');
  expect(preview?.textContent).toContain('Initial brief');
  expect(preview?.textContent).toContain('PR review');
  expect(preview?.querySelector('[data-task-status-indicator-state="awaiting_response"]')).not.toBeNull();
  expect(block.getAttribute('aria-describedby')).toBe(preview?.id ?? null);
  expect(preview?.textContent).not.toContain('/flow/steps');
  await act(async () => block.focus());
  await key('Escape');
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});

it('opens a bounded context menu and navigates actions without executing a block', async () => {
  let count = 0;
  const { block } = await mount({ run: () => { count++; } });
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5000, clientY: 5000 });
  await act(async () => block.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(count).toBe(0);
  expect(document.activeElement?.textContent).toBe('Details');
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect(parseFloat(menu.style.left)).toBeLessThan(window.innerWidth);
  await key('ArrowDown'); expect(document.activeElement?.textContent).toBe('Open task');
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(count).toBe(1);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('supports keyboard menus and closes only the popup inside the workflow dialog', async () => {
  const scene = await mount({ insideDialog: true });
  await act(async () => scene.block.focus());
  await key('F10', true);
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(document.querySelector('[role="menu"]')?.hasAttribute('inert')).toBe(false);
  await key('Escape');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(scene.closes()).toBe(0);
  expect(document.activeElement).toBe(scene.block);
  await key('Escape'); expect(scene.closes()).toBe(1);
});

it('dismisses previews on graph movement and menus on outside pointer down', async () => {
  const { block } = await mount();
  await hover(block);
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await mount({ dismissSignal: 1 });
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => block.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('supports a canvas menu without requiring a block or changing selection', async () => {
  const { block } = await mount();
  let fitted = false;
  await act(async () => root!.render(<WorkflowGraphPopup anchor={block} position={{ left: 20, top: 30 }}
    label="Graph actions" onClose={() => {}} actions={[{ label: 'Fit graph', icon: null, run: () => { fitted = true; } }]} />));
  expect(fitted).toBe(false);
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(fitted).toBe(true);
});

it('prefers the agent instruction over shared skill guidance in the compact preview', async () => {
  await mount();
  await act(async () => root!.render(<WorkflowBlockSummary card={{ ...card, promptSources: [
    { kind: 'text', mediaType: 'text/plain', text: 'Shared policy', reference: { label: 'policy', source: 'unknown' } },
    { kind: 'text', mediaType: 'text/plain', text: 'Check the release prerequisites.' },
  ] }} />));
  expect(host.querySelector('.agsdl-block-prompt')?.textContent).toBe('Check the release prerequisites.');
});

it('keeps the preview open while the pointer moves from its block onto the preview', async () => {
  const { block } = await mount();
  await hover(block);
  const preview = document.querySelector<HTMLElement>('[role="tooltip"]')!;
  await act(async () => {
    block.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: preview }));
    preview.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: block }));
    await new Promise(resolve => setTimeout(resolve, 160));
  });
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await act(async () => {
    preview.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await new Promise(resolve => setTimeout(resolve, 160));
  });
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
