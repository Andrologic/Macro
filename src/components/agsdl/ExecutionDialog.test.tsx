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
