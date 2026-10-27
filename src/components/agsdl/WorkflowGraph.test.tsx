import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkflowGraph } from './WorkflowGraph';
import { projectViewer } from '../../services/agsdl/viewer';
import { projectSystemOverview } from '../../services/agsdl/systemOverview';
import { demoPlans } from '../../demo/fixtures';

let root: Root | undefined;
const render = async (id: string) => {
  const plan = demoPlans.find(item => item.id === id)!;
  const projected = projectViewer(plan.agsdl.source, plan.agsdl);
  const graph = projectSystemOverview(projected.graphs[0], projected.declarations.filter(item => ['Agent', 'System'].includes(item.kind)));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<WorkflowGraph cards={graph.cards} edges={graph.edges} entry={graph.entry} declarations={projected.declarations}
    selected="" select={() => {}} title={card => card.title} />));
  return host;
};
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

it('leads with the agent and lights the blocks of a shared agent together on hover', async () => {
  const blocks = [...(await render('demo-incident')).querySelectorAll<HTMLButtonElement>('.agsdl-graph-node')];
  const text = (block: HTMLElement) => [block.querySelector('.agsdl-node-title')?.textContent, block.querySelector('.agsdl-node-subtitle')?.textContent];
  const analyst = blocks.filter(block => text(block)[0] === 'Analyste des traces');
  expect(analyst.map(block => text(block)[1]).sort()).toEqual(['Examiner les traces', 'Recentrer l’analyse']);

  await act(async () => analyst[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(analyst.every(block => block.classList.contains('is-lit'))).toBe(true);
  expect(blocks.filter(block => !analyst.includes(block)).every(block => block.classList.contains('is-faded'))).toBe(true);
  await act(async () => analyst[1].dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
  expect(blocks.some(block => block.classList.contains('is-lit') || block.classList.contains('is-faded'))).toBe(false);
});

it('marks the entry step and how each join collects its members', async () => {
  const incident = await render('demo-incident');
  const entries = [...incident.querySelectorAll('.agsdl-node-entry')];
  expect(entries).toHaveLength(1);
  expect(entries[0].parentElement?.querySelector('.agsdl-node-title')?.textContent).toBe('Responsable d’astreinte');
  act(() => root?.unmount()); incident.remove();

  const crisis = await render('demo-crisis');
  expect([...crisis.querySelectorAll('.agsdl-node-mode')].map(chip => chip.className)).toEqual(['agsdl-node-mode is-first', 'agsdl-node-mode is-all']);
});
