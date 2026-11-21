import { afterEach,expect,it } from 'bun:test';
import { act } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { blockDetails } from '../../services/agsdl/blockDetails';
import { createExample } from '../../services/agsdl/examples';
import { projectViewer } from '../../services/agsdl/viewer';
import { Dialog } from '../ui/Dialog';
import { WorkflowBlockOverlay,WorkflowBlockSummary } from './WorkflowBlockOverlay';
import { WorkflowGraphPopup,type GraphPopupAction } from './WorkflowGraphPopup';

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
const projected = projectViewer(createExample('release', 'agsdl-0.3.0'));
const card = projected.graphs[0].cards.find(card => card.kind === 'agent')!;
const details = blockDetails(card, projected.declarations);
const actions = (run = () => {}): GraphPopupAction[] => [
  { label: 'Details', icon: null, run }, { label: 'Open task', icon: null, run },
];
async function mount({ insideDialog = false, run = () => {}, dismissSignal = 0 } = {}) {
  if (!host?.isConnected) {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  }
  const block = <WorkflowBlockOverlay card={card} title="Release checklist" kindLabel="Agent"
    incoming={['Initial brief']} outgoing={['PR review']} details={details} actions={actions(run)} dismissSignal={dismissSignal}
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

it('shows a delayed configuration preview without repeating the block, then dismisses on Escape', async () => {
  const { block } = await mount();
  await hover(block);
  const preview = document.querySelector('[role="tooltip"]');
  const instructions = card.promptSources![0].text!;
  expect(preview?.textContent).toContain(instructions);
  // Title, neighbours and state are already on the canvas.
  expect(preview?.textContent).not.toContain('Release checklist');
  expect(preview?.textContent).not.toContain('Initial brief');
  expect(preview?.querySelector('[data-task-status-indicator-state]')).toBeNull();
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
  await act(async () => root!.render(<WorkflowBlockSummary card={{ ...card, edition030: undefined, promptSources: [
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


it('does not present a call description as agent instructions', async () => {
  await mount();
  await act(async () => root!.render(<WorkflowBlockSummary card={{ ...card, kind: 'call', mission: 'Runs a check', promptSources: undefined, edition030: { sourceJson: '{}', routes: [] } }} />));
  expect(host.textContent).toContain('Runs a check');
  expect(host.textContent).not.toContain('Instructions');
});

it('labels every direct and referenced 0.3 instruction without dropping the agent description', async () => {
  const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'x', content: { shared: { value: 'Referenced instruction' } }, agents: {
    a: { harness: 'codex', permissions: 'read-only', description: 'Agent description', instructions: [{ value: 'Direct instruction' }, { ref: 'shared' }] },
  } });
  const agent = projectViewer(source).declarations.find(item => item.path === '/agents/a')!;
  await mount();
  await act(async () => root!.render(<WorkflowBlockSummary card={agent} />));
  expect(host.textContent).toContain('Agent description');
  expect(host.textContent).toContain('Instructions');
  expect(host.textContent).toContain('Direct instruction');
  expect(host.textContent).toContain('Referenced instruction');
  expect(host.textContent).toContain('shared');
  const referenceOnly = { ...agent, promptSources: agent.promptSources!.slice(1) };
  await act(async () => root!.render(<WorkflowBlockSummary card={referenceOnly} />));
  expect(host.textContent).toContain('Instructions');
  expect(host.textContent).toContain('Referenced instruction');
  const noInstructions = { ...agent, promptSources: [], mission: 'Agent description' };
  await act(async () => root!.render(<WorkflowBlockSummary card={noInstructions} />));
  expect(host.textContent).toContain('Agent description');
  expect(host.textContent).not.toContain('Instructions');
});


it('keeps the descriptions of an agent definition and its step distinct', async () => {
  const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'x', agents: {
    reviewer: { harness: 'codex', permissions: 'read-only', description: 'Definition description' },
  }, flow: { entry: 'review', steps: { review: { type: 'agent', agent: 'reviewer', description: 'Step description' } } } });
  const step = projectViewer(source).graphs[0].cards[0];
  await mount();
  await act(async () => root!.render(<WorkflowBlockSummary card={step} />));
  expect(host.textContent).toContain('Step description');
  expect(host.textContent).toContain('Definition description');
  expect(host.textContent).toContain('Shared agent definition');
});

it('opens the 0.3 business preview and advanced details by keyboard without losing focus', async () => {
  await mount();
  const source = JSON.stringify({ contract: 'agsdl-0.3.0', id:'preview', agents:{a:{harness:'example',permissions:'read-only',skills:['policy']}},
    flow:{entry:'review',steps:{review:{type:'agent',agent:'a',maxVisits:3}}}});
  const step = projectViewer(source).graphs[0].cards[0];
  await act(async () => root!.render(<WorkflowBlockOverlay card={step} title="Review" kindLabel="Agent" incoming={[]} outgoing={[]}
    details={blockDetails(step,[])} actions={actions()} occurrences={[{activationId:'first',state:'completed'},{activationId:'second',state:'active'}]}><button>Review</button></WorkflowBlockOverlay>));
  const button = host.querySelector('button')!;
  await act(async () => button.focus());
  await key('ArrowRight');
  await act(async () => new Promise(resolve=>requestAnimationFrame(() => resolve(undefined))));
  const preview = document.querySelector('[role="tooltip"]')!;
  expect(preview.textContent).toContain('Same conversation');
  const summary = preview.querySelector('summary')!;
  expect(document.activeElement).toBe(summary);
  await act(async () => summary.click());
  expect(document.querySelector('[role="tooltip"]')).toBe(preview);
  expect(preview.querySelector('details')?.open).toBe(true);
  expect(preview.querySelectorAll('.agsdl-occurrence-list li')).toHaveLength(2);
  await key('Escape');
  expect(document.activeElement).toBe(button);
  await act(async () => new Promise(resolve => setTimeout(resolve, 480)));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
