import { afterEach, expect, it, spyOn, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExecutionDialog } from "./ExecutionDialog";
import { useAgsdlExecutionStore } from "../../stores/useAgsdlExecutionStore";
import { useChatStore } from "../../stores/useChatStore";
import type { PublicSnapshot, PublicProjection, DeliveryId, ExactJsonText, PublicExecutionIntent } from "../../services/agsdlExecution/contracts";
import i18n from "../../i18n";
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); act(() => root?.unmount()); host?.remove(); mock.restore(); useAgsdlExecutionStore.setState({ loaded: false, busy: false, error: undefined, runs: [], owner: undefined, snapshot: undefined, projection: undefined, intent: undefined, intentBusy: false, stopping: false }); useChatStore.setState({ selectedConversationId: null, conversations: [] }); });
it("offers a simple prompt and real Agent selection while keeping technical identities and error detail out of visible text", async () => {
  const owner = { projectId: 'project', planId: 'plan', branch: 'work' };
  const source = { owner, revision: '9007199254740993', sourceSha256: 'a'.repeat(64) };
  const authoredSource = '{"agents":{"real-agent":{}}}';
  spyOn(useAgsdlExecutionStore.getState(), 'open').mockResolvedValue(undefined);
  useChatStore.setState({ selectedConversationId: 'conversation', conversations: [{ id: 'conversation', project_id: 'project' } as ReturnType<typeof useChatStore.getState>['conversations'][number]] });
  useAgsdlExecutionStore.setState({ owner, conversationId: 'conversation', loaded: true, busy: false, error: 'A public error detail',
    preflight: { source, authoredSource, staticValid: true, runtimeSupported: true, productRuntimeAvailable: false, registryVersion: 'registry', diagnostics: [{ code: 'CODE', pointer: '', message: 'A preflight error detail' }], incomplete: false },
    snapshot: { source, authoredSource, systemStartId: 'hidden-run-identity' } as PublicSnapshot,
    projection: { source, systemStartId: 'hidden-run-identity', cursor: '9007199254740995', agents: [], activations: [], nextPage: null, systemStop: { kind: 'none' } } as unknown as PublicProjection,
    diagnostic: { source, systemStartId: 'hidden-run-identity', activation: null, through: '9007199254740995', diagnostics: [{ id: 'hidden-run-identity:1', sequence: '1', code: 'CODE', pointer: '', message: 'A runtime error detail', work: null }], incomplete: false, nextBefore: null },
    runs: [], approvals: undefined });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<ExecutionDialog target={{ planId: 'plan', branchName: 'work' }} onClose={() => {}} />));
  const panel = document.body.querySelector('[role="dialog"]')!;
  for (const detail of ['hidden-run-identity', source.sourceSha256, source.revision, '9007199254740995', 'A public error detail', 'A preflight error detail', 'A runtime error detail', 'Supported by this runtime']) expect(panel.textContent).not.toContain(detail);
  expect(panel.querySelector('textarea')).toBeNull();
  expect(panel.querySelector('select[aria-label="Agent"]')).toBeNull();
  expect(panel.querySelector<HTMLButtonElement>('[aria-label="Start"]')!.disabled).toBe(true);
  expect([...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Send message')).toBeUndefined();
  act(() => useAgsdlExecutionStore.setState({ preflight: { ...useAgsdlExecutionStore.getState().preflight!, productRuntimeAvailable: true } }));
  expect(panel.querySelector('textarea')).not.toBeNull();
  expect(panel.querySelector('select[aria-label="Agent"]')?.textContent).toContain('real-agent');
  expect(panel.querySelector('input[type="checkbox"]')).toBeNull();
  expect(panel.textContent).not.toContain("Execution diagnostics");
  await act(async () => { await i18n.changeLanguage('fr'); });
  for (const [key, text] of [
    ['intentOpen', 'Reprenez ou abandonnez la demande en attente avant d’en lancer une autre.'],
    ['refused.SOURCE_CHANGED', 'La source a changé avant l’acceptation de la demande.'],
    ['saveBeforeStart', 'Enregistrez la source actuelle et actualisez avant de démarrer.'],
    ['ownerChanged', 'Ouvrez la conversation de ce plan avant de continuer.'],
    ['retryable', 'L’exécution n’est pas encore disponible. Reprendre conserve la même demande.'],
  ]) {
    act(() => useAgsdlExecutionStore.setState({ error: `agsdl.execution.${key}` }));
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain(text);
  }
  act(() => useAgsdlExecutionStore.setState({ error: 'Internal transport detail in English' }));
  expect(panel.querySelector('[role="alert"]')?.textContent).toContain(i18n.t('agsdl.execution.error', { ns: 'agsdl' }));
  expect(panel.textContent).not.toContain('Internal transport detail in English');
  await act(async () => { await i18n.changeLanguage('en'); });
  act(() => useAgsdlExecutionStore.setState({
    preflight: { ...useAgsdlExecutionStore.getState().preflight!, productRuntimeAvailable: true },
    intent: { formatVersion: '1', key: { scope: { owner, conversationId: 'conversation' }, intentId: 'hidden-intent-identity' }, revision: '9007199254740997',
      payload: { kind: 'deliver', source, request: { systemStartId: useAgsdlExecutionStore.getState().snapshot!.systemStartId, deliveryId: 'retained' as DeliveryId, agentName: 'real-agent', messageJson: '{"prompt":[]}' as ExactJsonText } },
      state: { kind: 'submissionPending', retryableFailure: 'RUNTIME_UNAVAILABLE' } } as unknown as PublicExecutionIntent,
  }));
  expect(panel.querySelector<HTMLButtonElement>('[aria-label="Start"]')!.disabled).toBe(true);
  expect([...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Send message')?.disabled).toBe(true);
  expect(panel.textContent).toContain('Request in progress');
  for (const detail of ['hidden-intent-identity', '9007199254740997', 'RUNTIME_UNAVAILABLE', 'retained']) expect(panel.textContent).not.toContain(detail);
  expect(panel.querySelector<HTMLButtonElement>('[aria-label="Resume"]')!.disabled).toBe(false);
  expect(panel.querySelector<HTMLButtonElement>('[aria-label="Discard request"]')!.disabled).toBe(false);
  act(() => useAgsdlExecutionStore.setState({ intentBusy: true }));
  expect(panel.querySelector<HTMLButtonElement>('[aria-label="Request stop"]')!.disabled).toBe(false);
});
it("opens read-only without calling support missing, drops diagnostics of another run and keeps attach failures generic", async () => {
  const owner = { projectId: 'project', planId: 'plan', branch: 'work' };
  const source = { owner, revision: '1', sourceSha256: 'b'.repeat(64) };
  const run = (id: string) => ({
    snapshot: { source, authoredSource: '{}', systemStartId: id } as PublicSnapshot,
    projection: { source, systemStartId: id, cursor: '7', agents: [], activations: [], nextPage: null, systemStop: { kind: 'none' } } as unknown as PublicProjection,
    diagnostic: { source, systemStartId: id, activation: null, through: '7', diagnostics: [{ id: `${id}:1`, sequence: '1', code: 'CODE', pointer: '', message: 'detail', work: null }], incomplete: false, nextBefore: null },
  });
  spyOn(useAgsdlExecutionStore.getState(), 'open').mockResolvedValue(undefined);
  const { notify } = await import("../ui/toastService");
  const notified = spyOn(notify, 'error').mockReturnValue('attach-failed');
  const chatContext = await import("../../stores/agsdl/chatContext");
  spyOn(chatContext, 'prepareAgsdlRuntimeContext').mockRejectedValue({ code: 'UNEXPECTED_ERROR', message: 'native transport detail' });
  useChatStore.setState({ selectedConversationId: 'conversation', conversations: [{ id: 'conversation', project_id: 'project' } as ReturnType<typeof useChatStore.getState>['conversations'][number]] });
  useAgsdlExecutionStore.setState({ owner, conversationId: 'conversation', loaded: true, busy: false, error: undefined, preflight: undefined, runs: [], approvals: undefined, stale: false, ...run('run-a') });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<ExecutionDialog target={{ planId: 'plan', branchName: 'work' }} onClose={() => {}} />));
  const panel = document.body.querySelector('[role="dialog"]')!;
  const start = panel.querySelector<HTMLButtonElement>('[aria-label="Start"]')!;
  expect(start.disabled).toBe(true);
  expect(start.title).toBe('Not checked yet. Refresh to check.');
  expect(panel.innerHTML).not.toContain('Unsupported by this runtime');
  act(() => useAgsdlExecutionStore.setState({ preflight: { source: useAgsdlExecutionStore.getState().snapshot!.source, authoredSource: JSON.stringify({ flow: { entry: 'ask' } }), productRuntimeAvailable: false, diagnostics: [], staticValid: true, runtimeSupported: true, registryVersion: 'test', incomplete: false } }));
  expect(panel.querySelector('textarea')).toBeNull();
  act(() => useAgsdlExecutionStore.setState({ preflight: undefined }));

  act(() => useAgsdlExecutionStore.setState(run('run-b')));
  expect(panel.querySelector('input[type="checkbox"]')).toBeNull();
  await act(async () => { panel.querySelector<HTMLButtonElement>('[aria-label="Attach to chat"]')!.click(); });
  expect(notified).toHaveBeenCalledWith('The document changed. Attach the selection again before sending.', { description: 'The action failed. Try again.' });
});

it("distinguishes loading, read failure and an empty execution history without offering a fake run", async () => {
  const owner = { projectId: 'project', planId: 'plan', branch: 'work' };
  const open = spyOn(useAgsdlExecutionStore.getState(), 'open').mockResolvedValue(undefined);
  useChatStore.setState({ selectedConversationId: 'conversation', conversations: [{ id: 'conversation', project_id: 'project' } as ReturnType<typeof useChatStore.getState>['conversations'][number]] });
  useAgsdlExecutionStore.setState({ owner, conversationId: 'conversation', loaded: false, busy: true, error: undefined, snapshot: undefined, runs: [], preflight: undefined });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<ExecutionDialog target={{ planId: 'plan', branchName: 'work' }} onClose={() => {}} />));
  const panel = document.body.querySelector('[role="dialog"]')!;
  expect(panel.querySelector('[role="status"]')?.textContent).toContain('Loading executions');
  expect(panel.querySelector('select')).toBeNull();
  act(() => useAgsdlExecutionStore.setState({ busy: false, error: 'Native failure secret' }));
  expect(panel.querySelector('[role="alert"]')?.textContent).toContain('Could not load executions.');
  expect(panel.textContent).not.toContain('Native failure secret');
  const retries = open.mock.calls.length;
  await act(async () => { [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!.click(); });
  expect(open.mock.calls.length).toBe(retries + 1);
  act(() => useAgsdlExecutionStore.setState({ loaded: true, error: undefined }));
  expect(panel.textContent).toContain('No executions yet');
  expect(panel.querySelector('select')).toBeNull();
  expect(panel.querySelector('[aria-label="Start"]')).toBeNull();
  expect(panel.querySelector('[aria-label="Close"]')).not.toBeNull();
  act(() => useChatStore.setState({ selectedConversationId: null }));
  expect(panel.textContent).toContain('Send a first message in this plan');
  expect(panel.textContent).not.toContain('attaching AgSDL context');
});


it("shows a failed readiness check for a system with no execution and sends details to chat only", async () => {
  const owner = { projectId: 'project', planId: 'plan', branch: 'work' };
  const source = { owner, revision: '1', sourceSha256: 'c'.repeat(64) };
  spyOn(useAgsdlExecutionStore.getState(), 'open').mockResolvedValue(undefined);
  useChatStore.setState({ selectedConversationId: 'conversation', conversations: [{ id: 'conversation', project_id: 'project' } as ReturnType<typeof useChatStore.getState>['conversations'][number]] });
  useAgsdlExecutionStore.setState({ owner, conversationId: 'conversation', loaded: true, busy: false, error: undefined,
    snapshot: undefined, projection: undefined, diagnostic: undefined, intent: undefined, runs: [],
    preflight: { source, authoredSource: '{}', staticValid: true, runtimeSupported: false, productRuntimeAvailable: true,
      registryVersion: 'registry', incomplete: false, diagnostics: [{ code: 'UNSUPPORTED', pointer: '/configuration', message: 'Technical readiness detail' }] } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<ExecutionDialog target={{ planId: 'plan', branchName: 'work' }} onClose={() => {}} />));
  const panel = document.querySelector('[role="dialog"]')!;
  expect(panel.textContent).toContain(i18n.t('agsdl.execution.unsupported', { ns: 'agsdl' }));
  expect(panel.textContent).not.toContain('Technical readiness detail');
  expect(panel.querySelector('[aria-label="Execution diagnostics"]')).not.toBeNull();
  expect(panel.querySelector('[aria-label="Start"]')).toBeNull();
});

it("requires inspection before starting anew after a lost result, without treating Stop as rollback", async () => {
  const owner = { projectId: 'project', planId: 'plan', branch: 'work' };
  const source = { owner, revision: '1', sourceSha256: 'd'.repeat(64) };
  spyOn(useAgsdlExecutionStore.getState(), 'open').mockResolvedValue(undefined);
  const start = spyOn(useAgsdlExecutionStore.getState(), 'start').mockResolvedValue(undefined);
  useChatStore.setState({ selectedConversationId: 'conversation', conversations: [{ id: 'conversation', project_id: 'project' } as ReturnType<typeof useChatStore.getState>['conversations'][number]] });
  useAgsdlExecutionStore.setState({ owner, conversationId: 'conversation', loaded: true, busy: false, error: undefined,
    preflight: { source, authoredSource: '{"flow":{}}', staticValid: true, runtimeSupported: true, productRuntimeAvailable: true, registryVersion: 'r', diagnostics: [], incomplete: false },
    snapshot: { source, authoredSource: '{"flow":{}}', systemStartId: 'lost-run' } as PublicSnapshot,
    runs: [{ source, systemStartId: 'lost-run', systemStop: { kind: 'confirmed', requestId: 'stop' }, counts: { queued:'0', active:'0', uncertain:'0', completed:'0', failed:'0', stopped:'1' } } as unknown as ReturnType<typeof useAgsdlExecutionStore.getState>['runs'][number]],
    projection: undefined,
    diagnostic: { source, systemStartId: 'lost-run', activation: null, through: '3', diagnostics: [{ id:'lost-run:1', sequence:'1', code:'RECOVERY_RESULT_LOST', pointer:'', message:'technical lost result detail', work:null }], incomplete:false, nextBefore:null },
    intent: undefined, approvals: undefined });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<ExecutionDialog target={{planId:'plan',branchName:'work'}} onClose={()=>{}} />));
  const panel = document.querySelector('[role="dialog"]')!;
  expect(panel.textContent).toContain('The previous result is unknown');
  expect(panel.textContent).not.toContain('technical lost result detail');
  const button = panel.querySelector<HTMLButtonElement>('[aria-label="Start"]')!;
  expect(button.disabled).toBe(true);
  await act(async () => panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button.disabled).toBe(false);
  // No restart is performed by acknowledgement itself.
  expect(start.mock.calls.length).toBe(0);
  act(() => useAgsdlExecutionStore.setState({snapshot: {...useAgsdlExecutionStore.getState().snapshot!,systemStartId:'another-run'} as PublicSnapshot,runs:[]}));
  expect(panel.querySelector<HTMLInputElement>('input[type="checkbox"]')).toBeNull();
});
