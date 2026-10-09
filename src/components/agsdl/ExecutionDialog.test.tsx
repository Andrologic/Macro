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
afterEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); act(() => root?.unmount()); host?.remove(); mock.restore(); useAgsdlExecutionStore.setState({ owner: undefined, snapshot: undefined, projection: undefined, intent: undefined, intentBusy: false, stopping: false }); useChatStore.setState({ selectedConversationId: null, conversations: [] }); });
it("offers a simple prompt and real Agent selection while keeping technical identities and error detail out of visible text", async () => {
  const owner = { projectId: 'project', planId: 'plan', branch: 'work' };
  const source = { owner, revision: '9007199254740993', sourceSha256: 'a'.repeat(64) };
  const authoredSource = '{"agents":{"real-agent":{}}}';
  spyOn(useAgsdlExecutionStore.getState(), 'open').mockResolvedValue(undefined);
  useChatStore.setState({ selectedConversationId: 'conversation', conversations: [{ id: 'conversation', project_id: 'project' } as ReturnType<typeof useChatStore.getState>['conversations'][number]] });
  useAgsdlExecutionStore.setState({ owner, conversationId: 'conversation', busy: false, error: 'A public error detail',
    preflight: { source, authoredSource, staticValid: true, runtimeSupported: true, productRuntimeAvailable: false, registryVersion: 'registry', diagnostics: [{ code: 'CODE', pointer: '', message: 'A preflight error detail' }], incomplete: false },
    snapshot: { source, authoredSource, systemStartId: 'hidden-run-identity' } as PublicSnapshot,
    projection: { source, systemStartId: 'hidden-run-identity', cursor: '9007199254740995', agents: [], activations: [], nextPage: null, systemStop: { kind: 'none' } } as unknown as PublicProjection,
    diagnostic: { source, systemStartId: 'hidden-run-identity', activation: null, through: '9007199254740995', diagnostics: [{ id: 'hidden-run-identity:1', sequence: '1', code: 'CODE', pointer: '', message: 'A runtime error detail', work: null }], incomplete: false, nextBefore: null },
    runs: [], approvals: undefined });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<ExecutionDialog target={{ planId: 'plan', branchName: 'work' }} onClose={() => {}} />));
  const panel = document.body.querySelector('[role="dialog"]')!;
  for (const detail of ['hidden-run-identity', source.sourceSha256, source.revision, '9007199254740995', 'A public error detail', 'A preflight error detail', 'A runtime error detail', 'Supported by this runtime', 'Product execution unavailable']) expect(panel.textContent).not.toContain(detail);
  expect(panel.querySelector('textarea')).not.toBeNull();
  expect(panel.querySelector('select[aria-label="Agent"]')?.textContent).toContain('real-agent');
  expect(panel.querySelector<HTMLButtonElement>('[aria-label="Start"]')!.disabled).toBe(true);
  expect([...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Send message')?.disabled).toBe(true);
  expect(panel.querySelector('[title="A runtime error detail"] input[type="checkbox"]')).not.toBeNull();
  await act(async () => { await i18n.changeLanguage('fr'); });
  for (const [key, text] of [
    ['intentOpen', 'Reprenez ou abandonnez la demande en attente avant d’en lancer une autre.'],
    ['refused.SOURCE_CHANGED', 'La source a changé avant l’acceptation de la demande.'],
    ['saveBeforeStart', 'Enregistrez la source actuelle et actualisez avant de démarrer.'],
    ['ownerChanged', 'Ouvrez la conversation de ce plan avant de continuer.'],
    ['retryable', 'L’exécution n’est pas encore disponible. Reprendre conserve la même demande.'],
  ]) {
    act(() => useAgsdlExecutionStore.setState({ error: `agsdl.execution.${key}` }));
    expect(panel.querySelector('[role="img"].agsdl-unresolved')?.getAttribute('title')).toBe(text);
  }
  act(() => useAgsdlExecutionStore.setState({ error: 'Internal transport detail in English' }));
  expect(panel.querySelector('[role="img"].agsdl-unresolved')?.getAttribute('title')).toBe(i18n.t('agsdl.execution.error', { ns: 'agsdl' }));
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
  useAgsdlExecutionStore.setState({ owner, conversationId: 'conversation', busy: false, error: undefined, preflight: undefined, runs: [], approvals: undefined, stale: false, ...run('run-a') });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<ExecutionDialog target={{ planId: 'plan', branchName: 'work' }} onClose={() => {}} />));
  const panel = document.body.querySelector('[role="dialog"]')!;
  const start = panel.querySelector<HTMLButtonElement>('[aria-label="Start"]')!;
  expect(start.disabled).toBe(true);
  expect(start.title).toBe('Not checked yet. Refresh to check.');
  expect(panel.innerHTML).not.toContain('Unsupported by this runtime');

  const checkbox = () => panel.querySelector<HTMLInputElement>('.agsdl-execution-diagnostic input')!;
  await act(async () => { checkbox().click(); });
  expect(checkbox().checked).toBe(true);
  act(() => useAgsdlExecutionStore.setState(run('run-b')));
  expect(checkbox().checked).toBe(false);

  await act(async () => { checkbox().click(); });
  await act(async () => { panel.querySelector<HTMLButtonElement>('[aria-label="Attach to chat"]')!.click(); });
  expect(notified).toHaveBeenCalledWith('The document changed. Attach the selection again before sending.', { description: 'The action failed. Try again.' });
});
