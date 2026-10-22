import * as ipc from './services/ipc/agsdlExecution';
import type { ActivationId, DeliveryId, ExactJsonText, ExecutionIntentKey, ExecutionIntentPayload, ExecutionIntentScope, IntentId, IntentRevision, PublicExecutionIntent, SourceRevision, SystemStartId } from './services/agsdlExecution/contracts';

/** Structured native errors are objects; never collapse them to "[object Object]". */
function describeQaError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) return JSON.stringify(error, null, 2);
  return String(error);
}

async function start(): Promise<void> {
  if (!import.meta.env.DEV || !await ipc.executionQaAvailable()) throw new Error('This page requires an isolated native debug QA profile.');
  const main = document.querySelector<HTMLElement>('#qa')!;
  main.replaceChildren();
  const heading = document.createElement('h1'); heading.textContent = 'Resident host qualification'; main.append(heading);
  const note = document.createElement('p'); note.textContent = 'Existing canonical plan only. Configure the synthetic provider through Macro Settings. Product execution remains unavailable.'; main.append(note);
  function field(name: string, initial = ''): HTMLInputElement {
    const label = document.createElement('label'); label.textContent = `${name} `;
    const input = document.createElement('input'); input.value = initial; input.size = 48; label.append(input);
    const row = document.createElement('p'); row.append(label); main.append(row); return input;
  }
  const params = new URL(location.href).searchParams;
  const project = field('Project ID', params.get('project') ?? ''), plan = field('Plan ID', params.get('plan') ?? ''), branch = field('Branch', params.get('branch') ?? '');
  const conversation = field('Conversation ID', params.get('conversation') ?? '');
  const run = field('Run ID', params.get('run') ?? '');
  const intent = field('Intent ID', params.get('intent') ?? '');
  const activation = field('Activation ID (targeted Stop)');
  const flowLabel = document.createElement('label'); flowLabel.textContent = 'Start with flow entry Message ';
  const flowEntry = document.createElement('input'); flowEntry.type = 'checkbox'; flowLabel.append(flowEntry);
  const flowRow = document.createElement('p'); flowRow.append(flowLabel); main.append(flowRow);
  const agent = field('Agent name', 'worker'), delivery = field('Delivery ID', crypto.randomUUID());
  const messageLabel = document.createElement('label'); messageLabel.textContent = 'Inline Message JSON';
  const message = document.createElement('textarea'); message.rows = 5; message.cols = 90;
  message.value = '{"prompt":[{"value":"QA-HOLD","mediaType":"text/plain"}]}'; messageLabel.append(message); main.append(messageLabel);
  const actions = document.createElement('p'), approvals = document.createElement('section'), output = document.createElement('pre');
  main.append(actions, approvals, output);
  let source: SourceRevision | null = null;
  const show = (value: unknown) => { output.textContent = JSON.stringify(value, null, 2); };
  function button(label: string, action: () => Promise<unknown>, parent: HTMLElement = actions) {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = () => { button.disabled = true; void action().then(value => { if (value !== undefined) show(value); }).catch(error => { output.textContent = describeQaError(error); }).finally(() => { button.disabled = false; }); };
    parent.append(button);
  }
  async function refresh() {
    const projection = await ipc.readExecutionProjection(run.value as SystemStartId);
    approvals.replaceChildren();
    const scope = { systemStartId: run.value, source: projection.source };
    const pending = await ipc.readExecutionApprovals(scope);
    for (const approval of pending.approvals) {
      const row = document.createElement('p'); row.textContent = `${approval.toolName}: ${approval.summary} `;
      for (const [label, approve] of [['Approve', true], ['Deny', false]] as const) button(label, async () => {
        await ipc.decideExecutionApproval({ scope, approvalId: approval.approvalId, approve }); return refresh();
      }, row);
      approvals.append(row);
    }
    if (pending.incomplete) approvals.append(document.createTextNode('Additional pending approvals exist.'));
    return projection;
  }
  button('Probe private caller refusal', async () => {
    try { await ipc.executionHostOwners(); }
    catch { return { privateCallerRejected: true }; }
    throw new Error('Private owner port accepted a public QA caller. Stop qualification.');
  });
  button('Catalogue', ipc.executionModelChoices);
  button('Preflight', async () => {
    const result = await ipc.preflightExecution({ owner: { projectId: project.value, planId: plan.value, branch: branch.value }, expected: null });
    source = result.source as SourceRevision; return result;
  });
  // Retain an ambiguous Start key for the same source rather than manufacturing another run.
  let startRequest: Parameters<typeof ipc.startExecution>[0] | null = null;
  button('Start graphless', async () => {
    if (!source) throw new Error('Run Preflight first.');
    if (!startRequest || JSON.stringify(startRequest.source) !== JSON.stringify(source)) startRequest = { source, requestId: crypto.randomUUID(), profile: 'macro-serial-inline-v1', associations: {}, entry: null };
    const result = await ipc.startExecution(startRequest); run.value = result.systemStartId;
    const url = new URL(location.href); url.searchParams.set('run', run.value); history.replaceState(null, '', url); return result;
  });
  button('Deliver', () => ipc.deliverExecution({ systemStartId: run.value as SystemStartId, deliveryId: delivery.value as DeliveryId, agentName: agent.value, messageJson: message.value as ExactJsonText }));
  button('Run existing delivery', () => ipc.executionQaRun(run.value, delivery.value));
  button('Refresh / approvals', refresh);
  button('Stop system', () => ipc.stopExecution({ systemStartId: run.value as SystemStartId, requestId: crypto.randomUUID() }));
  button('Replace native host', ipc.executionQaReplaceHost);
  button('Events', async () => ipc.readExecutionEvents(run.value as SystemStartId, null, 200));

  // Durable intents: the same typed wrappers the product store uses. The page
  // keeps only field values; SQLite retains the request, keys and admission.
  const intents = document.createElement('p'); main.insertBefore(intents, approvals);
  const scope = (): ExecutionIntentScope => ({ owner: { projectId: project.value, planId: plan.value, branch: branch.value }, conversationId: conversation.value });
  const key = (): ExecutionIntentKey => ({ scope: scope(), intentId: intent.value as IntentId });
  const remember = (row: PublicExecutionIntent) => {
    intent.value = row.key.intentId;
    const admission = row.state.kind === 'admitted' || row.state.kind === 'closed' ? row.state.admission : null;
    if (admission) run.value = admission.kind === 'start' ? admission.receipt.systemStartId : admission.receipt.work.systemStartId;
    const url = new URL(location.href);
    for (const [name, value] of [['project', project.value], ['plan', plan.value], ['branch', branch.value], ['conversation', conversation.value], ['intent', intent.value], ['run', run.value]]) if (value) url.searchParams.set(name, value);
    history.replaceState(null, '', url);
    return row;
  };
  const stage = async (payload: ExecutionIntentPayload) => remember(await ipc.stageExecutionIntent({ scope: scope(), intentId: crypto.randomUUID() as IntentId, payload }));
  button('Stage Start intent', async () => {
    if (!source) throw new Error('Run Preflight first.');
    return stage({ kind: 'start', request: { source, requestId: crypto.randomUUID(), profile: 'macro-serial-inline-v1', associations: {},
      entry: flowEntry.checked ? { deliveryId: crypto.randomUUID() as DeliveryId, messageJson: message.value as ExactJsonText } : null } });
  }, intents);
  button('Stage Deliver intent', async () => {
    const snapshot = await ipc.readExecutionSnapshot(run.value as SystemStartId);
    return stage({ kind: 'deliver', source: snapshot.source, request: { systemStartId: run.value as SystemStartId, deliveryId: delivery.value as DeliveryId, agentName: agent.value, messageJson: message.value as ExactJsonText } });
  }, intents);
  button('Read scope intents', async () => {
    const rows = await ipc.readExecutionIntents({ scope: scope() });
    if (rows[0]) remember(rows[0]);
    return rows;
  }, intents);
  button('Read retained intent', async () => { const row = await ipc.readExecutionIntent(key()); return row && remember(row); }, intents);
  button('Submit retained intent', async () => remember(await ipc.submitExecutionIntent(key())), intents);
  button('Submit twice concurrently', async () => {
    const results = await Promise.allSettled([ipc.submitExecutionIntent(key()), ipc.submitExecutionIntent(key())]);
    for (const result of results) if (result.status === 'fulfilled') remember(result.value);
    return results.map(result => result.status === 'fulfilled' ? result.value : { rejected: describeQaError(result.reason) });
  }, intents);
  button('Submit and drop acknowledgement (reload)', async () => {
    // A real lost acknowledgement: the native task keeps running while this observer leaves.
    void ipc.submitExecutionIntent(key()).catch(() => undefined);
    location.reload();
  }, intents);
  button('Install projection then acknowledge', async () => {
    const row = await ipc.readExecutionIntent(key());
    if (row?.state.kind !== 'admitted') return row;
    remember(row);
    const projection = await refresh();
    if (projection.systemStartId !== run.value) throw new Error('Installed projection differs from the admitted run.');
    return { installedCursor: projection.cursor, closed: remember(await ipc.closeExecutionIntent({ key: row.key, expectedRevision: row.revision as IntentRevision, disposition: 'acknowledged' })) };
  }, intents);
  button('Discard retained intent', async () => {
    const row = await ipc.readExecutionIntent(key());
    if (!row) return row;
    return remember(await ipc.closeExecutionIntent({ key: row.key, expectedRevision: row.revision, disposition: 'discarded' }));
  }, intents);
  button('Submit and Ensure Stop concurrently', async () => {
    // Stop must neither wait for the submission nor depend on the intent slot.
    const stop = ipc.ensureExecutionStop({ systemStartId: run.value as SystemStartId, activationId: null });
    const [submitted, stopped] = await Promise.allSettled([ipc.submitExecutionIntent(key()), stop]);
    if (submitted.status === 'fulfilled') remember(submitted.value);
    return { submit: submitted.status === 'fulfilled' ? submitted.value : { rejected: describeQaError(submitted.reason) },
      stop: stopped.status === 'fulfilled' ? stopped.value : { rejected: describeQaError(stopped.reason) } };
  }, intents);
  button('Ensure Stop', async () => ipc.ensureExecutionStop({ systemStartId: run.value as SystemStartId, activationId: activation.value ? activation.value as ActivationId : null }), intents);
  button('Recent diagnostics', async () => {
    const projection = await ipc.readExecutionProjection(run.value as SystemStartId);
    return ipc.readExecutionDiagnostic({ systemStartId: run.value, source: projection.source, activationId: null, through: projection.cursor, recent: true });
  });
}
void start().catch(error => { document.querySelector('#qa')!.textContent = describeQaError(error); });
