import * as ipc from './services/ipc/agsdlExecution';
import type { DeliveryId, ExactJsonText, SourceRevision, SystemStartId } from './services/agsdlExecution/contracts';

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
  const project = field('Project ID'), plan = field('Plan ID'), branch = field('Branch');
  const run = field('Run ID', new URL(location.href).searchParams.get('run') ?? '');
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
    button.onclick = () => { button.disabled = true; void action().then(value => { if (value !== undefined) show(value); }).catch(error => { output.textContent = String(error); }).finally(() => { button.disabled = false; }); };
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
  button('Recent diagnostics', async () => {
    const projection = await ipc.readExecutionProjection(run.value as SystemStartId);
    return ipc.readExecutionDiagnostic({ systemStartId: run.value, source: projection.source, activationId: null, through: projection.cursor, recent: true });
  });
}
void start().catch(error => { document.querySelector('#qa')!.textContent = String(error); });
