import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ArchitectStrategyPanel from "./ArchitectStrategyPanel";
import { useAppStore } from "../../stores/useAppStore";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { createExample } from "../../services/agsdl/examples";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const originalApp = useAppStore.getState();
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  useAppStore.setState(originalApp);
  useAgsdlStore.setState({ sessions: {} });
});

const mount = async () => {
  const target = { branchName: "develop", planId: "layout-test" };
  useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: {
    source: createExample("release"), annexes: {}, version: "v1", persistedRevision: 0,
    dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null,
  } } });
  useAppStore.setState({ activeArchitectPlanId: target.planId, activePlanContext: {
    id: target.planId, targetBranch: "develop", status: "draft",
  } as NonNullable<ReturnType<typeof useAppStore.getState>["activePlanContext"]>, rightPanelWidth: 320, isLeftPanelOpen: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ArchitectStrategyPanel />));
  return container.querySelector<HTMLButtonElement>('.agsdl-viewer-header button[aria-label="Expand view"]')!;
};

it("opens the graph in a portal modal and closes without changing the panels or document", async () => {
  const expand = await mount();
  for (const close of ["button", "escape", "backdrop"]) {
    expand.focus();
    await act(async () => expand.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(container!.contains(dialog)).toBe(false);
    // The modal shows the same steps as the panel graph, never a different subset.
    const inline = container!.querySelectorAll(".agsdl-graph-node").length;
    expect(inline).toBeGreaterThan(0);
    expect(dialog.querySelectorAll(".agsdl-graph-node")).toHaveLength(inline);
    // The inline and modal graphs each keep their own dot pattern.
    const patterns = [...document.querySelectorAll(".react-flow__background pattern")];
    expect(patterns).toHaveLength(2);
    expect(new Set(patterns.map(pattern => pattern.id)).size).toBe(2);
    expect(useAppStore.getState().rightPanelWidth).toBe(320);
    expect(useAppStore.getState().isLeftPanelOpen).toBe(true);
    act(() => {
      if (close === "button") dialog.querySelector<HTMLButtonElement>('.agsdl-viewer-header button[aria-label="Close expanded view"]')!.click();
      if (close === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (close === "backdrop") dialog.parentElement!.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(expand);
    expect(container!.hasAttribute("inert")).toBe(false);
  }
  expect(Object.values(useAgsdlStore.getState().sessions)[0].dirty).toBe(false);
});

it("removes the expanded view and releases the background when the active plan is cleared", async () => {
  const expand = await mount();
  await act(async () => expand.click());
  expect(container!.hasAttribute("inert")).toBe(true);
  act(() => useAppStore.setState({ activeArchitectPlanId: null, activePlanContext: null }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container!.hasAttribute("inert")).toBe(false);
  expect(useAppStore.getState().rightPanelWidth).toBe(320);
  expect(useAppStore.getState().isLeftPanelOpen).toBe(true);
  act(() => useAppStore.setState({ activeArchitectPlanId: "layout-test", activePlanContext: {
    id: "layout-test", targetBranch: "develop", status: "draft",
  } as NonNullable<ReturnType<typeof useAppStore.getState>["activePlanContext"]> }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('opens captured executions without execution commands and keeps them after a blueprint replacement', async () => {
  const { configureWorkflowRunAccess030 } = await import('../../services/workflowAgentTasks');
  const { inspectionFixture030, monitorFixture030 } = await import('../../services/agsdl/runInspection030.testSupport');
  const run = inspectionFixture030(); const access = monitorFixture030(run);
  configureWorkflowRunAccess030(() => ({ access }));
  try {
    await mount();
    act(() => useAppStore.setState({ selectedProjectId:'sample-project' }));
    expect(container!.querySelector('nav')).toBeNull();
    expect(container!.querySelector('.agsdl-viewer')).not.toBeNull();
    expect(container!.querySelector('.agsdl-runs-drawer')?.hasAttribute('hidden')).toBe(true);
    await act(async () => container!.querySelector<HTMLButtonElement>('.agsdl-runs-toggle')!.click());
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-run-id="run-current"] button')!.click());
    expect(container!.querySelector('[data-captured-run="run-current"] .agsdl-canvas')).not.toBeNull();
    expect(access.reads.every(item => item === 'history' || item === 'run-current')).toBe(true);
    const key = agsdlSessionKey({branchName:'develop', planId:'layout-test'});
    act(() => useAgsdlStore.setState(state => ({sessions:{...state.sessions,[key]:{...state.sessions[key],source:'{"contract":"agsdl-0.3.0","id":"changed","agents":{}}'}}})));
    expect(container!.querySelector('[data-captured-run="run-current"]')).not.toBeNull();
    expect(container!.textContent).toContain('Captured graph differs from design');
    await act(async () => container!.querySelector<HTMLButtonElement>('.agsdl-runs-toggle')!.click());
    expect(container!.querySelector('[data-captured-run="run-current"] .agsdl-canvas')).not.toBeNull();
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Expand view"]')!.click());
    expect(document.body.querySelector('[role="dialog"] [data-captured-run="run-current"] .agsdl-canvas')).not.toBeNull();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close expanded view"]')!.click());
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Design"]')!.click());
    expect(container!.querySelector('.agsdl-viewer')).not.toBeNull();
  } finally { await act(async () => configureWorkflowRunAccess030(undefined)); }
});

it('never replaces a missing exact notification capture with the latest execution', async () => {
  const { WorkflowRunView030 } = await import('./ArchitectStrategyPanel');
  const { inspectionFixture030, monitorFixture030 } = await import('../../services/agsdl/runInspection030.testSupport');
  const run = inspectionFixture030(); const access = monitorFixture030(run);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root!.render(<WorkflowRunView030 bundle={{access}} target={{scope:{systemStartId:'missing',source:run.capture.source},requestId:'specific'}} />));
  expect(container.textContent).toContain('The requested execution is not available');
  expect(container.querySelector('[aria-label="Execution history"]')).toBeNull();
  expect(access.reads).toEqual(['history','missing']);
});

it('requires an explicit project for a system spanning multiple project owners', async () => {
  const { configureWorkflowRunAccess030 } = await import('../../services/workflowAgentTasks');
  const { monitorFixture030 } = await import('../../services/agsdl/runInspection030.testSupport');
  const scopes: unknown[] = [];
  configureWorkflowRunAccess030(scope => { scopes.push(scope); return {access:monitorFixture030()}; });
  try {
    await mount();
    act(() => useAppStore.setState({selectedProjectId:null,activePlanContext:{...useAppStore.getState().activePlanContext!,targetBranchesByProjectId:{'project-a':'develop','project-b':'main'}}}));
    expect(scopes).toEqual([]);
    const select = container!.querySelector('select[aria-label="Project"]') as HTMLSelectElement;
    await act(async () => { select.value='project-b';select.dispatchEvent(new Event('change',{bubbles:true})); });
    expect(scopes).toEqual([{owner:{projectId:'project-b',planId:'layout-test',branch:'main'},conversationId:undefined}]);
  } finally { await act(async () => configureWorkflowRunAccess030(undefined)); }
});

it('inspects the selected document owner when its execution branch differs', async () => {
  const { configureWorkflowRunAccess030 } = await import('../../services/workflowAgentTasks');
  const { monitorFixture030 } = await import('../../services/agsdl/runInspection030.testSupport');
  const scopes: unknown[] = [];
  configureWorkflowRunAccess030(scope => { scopes.push(scope); return { access: monitorFixture030() }; });
  try {
    await mount();
    act(() => useAppStore.setState({ selectedProjectId: 'selected-project', activePlanContext: {
      ...useAppStore.getState().activePlanContext!, targetBranchesByProjectId: { 'selected-project': 'main' },
    } }));
    expect(scopes).toEqual([{ owner: { projectId: 'selected-project', planId: 'layout-test', branch: 'develop' }, conversationId: undefined }]);
  } finally { await act(async () => configureWorkflowRunAccess030(undefined)); }
});

it('shows the native read-only notice beside the 0.3 launch controls', async () => {
  const { useAgsdlExecutionStore } = await import('../../stores/useAgsdlExecutionStore');
  await mount();
  const key = agsdlSessionKey({ branchName: 'develop', planId: 'layout-test' });
  try {
    await act(async () => {
      useAgsdlStore.setState(state => ({ sessions: { ...state.sessions, [key]: {
        ...state.sessions[key], source: '{"contract":"agsdl-0.3.0","id":"readonly","agents":{}}',
      } } }));
    });
    await act(async () => useAgsdlExecutionStore.setState({ notice030: 'agsdl.execution.readOnly030' }));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Start"]')!.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('This run is limited to read-only access');
    expect(container!.querySelector('textarea')).toBeNull();
  } finally { act(() => useAgsdlExecutionStore.setState({ notice030: undefined })); }
});

it('warns before launching an automatic plan without promising a native lock', async () => {
  await mount();
  const key = Object.keys(useAgsdlStore.getState().sessions)[0];
  act(() => useAgsdlStore.setState(state => ({sessions:{...state.sessions,[key]:{...state.sessions[key], source:'{"contract":"agsdl-0.3.0","id":"automatic","agents":{"worker":{"harness":"codex","permissions":"read-only","planFirst":"auto"}}}'}}})));
  await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Start"]')!.click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Automatic planning relies on instructions. Changes may happen before the plan is recorded.');
});

it('opens graphless launch controls without an entry prompt that would be ignored', async () => {
  await mount();
  const key = agsdlSessionKey({ branchName: 'develop', planId: 'layout-test' });
  await act(async () => useAgsdlStore.setState(state => ({ sessions: { ...state.sessions, [key]: {
    ...state.sessions[key], source: '{"contract":"agsdl-0.3.0","id":"messages","agents":{"worker":{"harness":"example","permissions":"read-only"}}}',
  } } })));
  await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Start"]')!.click());
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector('textarea')).toBeNull();
  expect(dialog.textContent).not.toContain('Input instructions');
});

it('keeps run, occurrence and stop target together when returning from the expanded graph', async () => {
  const { configureWorkflowRunAccess030 } = await import('../../services/workflowAgentTasks');
  const { inspectionFixture030, monitorFixture030, ready } = await import('../../services/agsdl/runInspection030.testSupport');
  const { useAgsdlExecutionStore } = await import('../../stores/useAgsdlExecutionStore');
  const originalExecution = useAgsdlExecutionStore.getState();
  const first = inspectionFixture030(), secondFixture = inspectionFixture030('run-second');
  const second = { ...secondFixture, state: { ...secondFixture.state,
    occurrences: ready(secondFixture.state.occurrences.kind === 'ready' ? secondFixture.state.occurrences.value.map((row, index) => index ? row : {
      ...row, activation: { ...row.activation, message: { sequence: '1', delivery: 'queue' as const, sender: 'host', messageJson: '{"prompt":"Second run message"}', statuses: ['consumed'], targetActivationId: null }, workText: 'Second run reply' },
    }) : []),
  } };
  const access = monitorFixture030(first, second), stopped: string[] = [];
  configureWorkflowRunAccess030(() => ({ access }));
  try {
    await mount();
    await act(async () => {
      useAppStore.setState({ selectedProjectId: 'sample-project' });
      useAgsdlExecutionStore.setState({ owner: { projectId: 'sample-project', planId: 'layout-test', branch: 'develop' }, launched030: 'run-current', stopping: false,
        stop030: async id => { stopped.push(id); } });
    });
    expect(container!.querySelector('[data-captured-run="run-current"]')).not.toBeNull();
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Expand view"]')!.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => dialog.querySelector<HTMLButtonElement>('.agsdl-runs-toggle')!.click());
    await act(async () => dialog.querySelector<HTMLButtonElement>('[data-run-id="run-second"] button')!.click());
    expect(dialog.querySelector('[data-captured-run="run-second"]')).not.toBeNull();
    const occurrence = [...dialog.querySelectorAll<HTMLButtonElement>('section[aria-label="Run inspector"] ol button')][1];
    expect(occurrence).toBeDefined();
    await act(async () => occurrence.click());
    await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close expanded view"]')!.click());
    expect(container!.querySelector('[data-captured-run="run-second"]')).not.toBeNull();
    expect(container!.querySelector('[data-run-id="run-second"] button')?.getAttribute('aria-pressed')).toBe('true');
    expect(container!.querySelector('section[aria-label="Messages"]')?.textContent).toContain('Second run reply');
    const selected = container!.querySelector('section[aria-label="Run inspector"] ol button[aria-pressed="true"]');
    expect(selected?.textContent).toBe(occurrence.textContent);
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!.click());
    expect(stopped).toEqual(['run-second']);
  } finally {
    await act(async () => { configureWorkflowRunAccess030(undefined); useAgsdlExecutionStore.setState(originalExecution); });
  }
});

it('opens the exact human occurrence from the design overlay without a previously rendered run graph', async () => {
  const { WorkflowRunView030 } = await import('./ArchitectStrategyPanel');
  const { inspectionFixture030, monitorFixture030, humanFixture030, ready } = await import('../../services/agsdl/runInspection030.testSupport');
  const { createHumanRequestClient030 } = await import('../../services/agsdl/humanRequests030');
  const { humanTransportDouble030, memoryDraftStorage030 } = await import('../agsdl/HumanRequests030.test-fixtures');
  const initial = inspectionFixture030(), human = humanFixture030(initial);
  const request = { ...human, occurrences: [{ workId: 'work-1', activation: { kind: 'available' as const, scope: initial.state.scope, activationId: 'activation-2' } }] };
  const run = { ...initial, state: { ...initial.state, humans: ready([request]) } };
  const access = monitorFixture030(run);
  const client = createHumanRequestClient030({ ...humanTransportDouble030(), storage: memoryDraftStorage030() });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root!.render(<WorkflowRunView030 bundle={{ access, humanClient: client }} canvas={<div data-design>Design</div>} />));
  expect(container.querySelector('[data-design]')).not.toBeNull();
  expect(container.querySelector('[data-captured-run]')).toBeNull();
  const overlay = container.querySelector('.agsdl-human-overlay')!;
  const link = overlay.querySelector<HTMLButtonElement>('article details p button')!;
  expect(link).not.toBeNull();
  await act(async () => link.click());
  expect(container.querySelector('[data-captured-run="run-current"]')).not.toBeNull();
  expect(container.querySelector<HTMLElement>('.agsdl-runs-drawer')!.hidden).toBe(false);
  const selected = container.querySelector('section[aria-label="Run inspector"] ol button[aria-pressed="true"]');
  expect(selected).not.toBeNull();
  expect(selected?.textContent).toContain('Review');
  expect(container.textContent).toContain('Late work.');
});
