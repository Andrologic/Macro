import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../../i18n';
import { notifiedHumanRequests030 } from '../../services/agsdl/humanAttention030';
import { notify } from '../ui/toastService';
import { HumanRequests030, type HumanRequests030Props } from './HumanRequests030';
import { createHumanRequestClient030 } from '../../services/agsdl/humanRequests030';
import type { RunHumanRequest030, RunHumanState030, RunRead030 } from '../../types/agsdlRunUi030';
import { humanFixture030, humanTransportDouble030, memoryDraftStorage030, resolutionFixture030, occurrence030 } from './HumanRequests030.test-fixtures';

let root: Root | undefined;
let host: HTMLDivElement;
let notification: ReturnType<typeof spyOn<typeof notify, 'actionRequired'>>;
let transport: ReturnType<typeof humanTransportDouble030>;
let props: HumanRequests030Props;
const opened: unknown[] = [];
beforeEach(async () => {
  notifiedHumanRequests030.clear();
  await i18n.changeLanguage('fr');
  notification = spyOn(notify, 'actionRequired').mockReturnValue('test');
  transport = humanTransportDouble030(); opened.length = 0;
  props = { requests: { kind: 'ready', revision: '0', value: [humanFixture030()] },
    client: createHumanRequestClient030({ ...transport, storage: memoryDraftStorage030() }),
    onOpenRequest: target => { opened.push(target); }, onOpenOccurrence: value => { opened.push(value); } };
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; notification.mockRestore(); await i18n.changeLanguage('en'); });
async function render(requests: RunRead030<readonly RunHumanRequest030[]> = props.requests) {
  props = { ...props, requests };
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root!.render(<HumanRequests030 {...props} />));
}
const ready = (request: RunHumanRequest030): RunRead030<readonly RunHumanRequest030[]> => ({ kind: 'ready', revision: request.revision, value: [request] });
async function text(value: string) {
  await act(async () => {
    const field = host.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(index: string) {
  await act(async () => { const field = host.querySelector('select')!; field.value = index; field.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function submit() { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }

it('shows exact captured data, all flow choices, observed budgets and exact notification/occurrence targets', async () => {
  await render();
  const request = humanFixture030();
  expect(host.textContent).toContain(request.content.kind === 'flowChoice' ? request.content.messageJson : 'bad fixture');
  expect(host.querySelectorAll('option')).toHaveLength(4);
  expect(host.textContent).toContain('0:50'); expect(host.textContent).toContain('1:55');
  expect(notification).toHaveBeenCalledTimes(1);
  const options = notification.mock.calls[0][1];
  expect(options.actions).toHaveLength(1);
  await options.actions[0].onClick();
  expect(opened[0]).toEqual({ scope: request.scope, requestId: request.id });
  await act(async () => host.querySelector<HTMLButtonElement>('article details p button')!.click());
  expect(opened[1]).toEqual(occurrence030);
  expect(occurrence030.activationId).not.toBe(request.workIds[0]);
});
it('retains drafts through conflict, revised props and remount, then shows a delivered negative choice', async () => {
  transport.setMode('conflict'); await render(); await choose('2'); await text('  À conserver\n '); await submit();
  expect(host.textContent).toContain('La demande a changé');
  expect(host.querySelector('textarea')!.value).toBe('  À conserver\n ');
  await render(ready({ ...humanFixture030(), revision: '1' }));
  expect(host.querySelector('select')!.value).toBe('2');
  await act(async () => root?.unmount()); root = undefined; host.remove(); await render();
  expect(host.querySelector('textarea')!.value).toBe('  À conserver\n ');
  transport.setMode('received'); await submit();
  expect(transport.submissions[1].expectedRevision).toBe('1');
  expect(transport.submissions[1].answer).toEqual({ kind: 'approval', choice: 'refuser', comment: '  À conserver\n ' });
  expect(host.textContent).toContain('Réponse remise, décision en attente');
  expect(host.querySelector('[data-human-answer]')?.textContent).toContain('refuser');
  await submit(); expect(transport.submissions).toHaveLength(2);
});
it('reads a competing decision after REQUEST_CLOSED and keeps the unsubmitted draft separate', async () => {
  await render(); await choose('0'); await text('Mon brouillon');
  transport.setMode('closed');
  transport.setCurrent({ ...humanFixture030(), revision: '1', state: { kind: 'consumed', receiptId: 's', resolutionReceiptId: 'r', resolution: resolutionFixture030() } });
  await submit();
  expect(host.textContent).toContain('Décision consommée');
  expect(host.querySelector('textarea')!.value).toBe('Mon brouillon');
  expect(host.querySelector('[data-human-answer]')?.textContent).toContain('Une réponse négative reste un choix normal.');
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});
it('never silently converts an MCP answer or infers a validator from expectedResponse', async () => {
  const question = humanFixture030({ content: { kind: 'question', question: 'Quel numéro ?', expectedResponse: 'Objet avec un entier exact.',
    answerContract: { kind: 'available', value: { protocol: 'mcp/elicitation', schemaJson: '{ "type": "object" }' } } } });
  transport.setCurrent(question); await render(ready(question));
  const exact = ' { "n": 900719925474099312345 }\n';
  await text(exact); await submit();
  expect(transport.submissions[0].answer).toEqual({ kind: 'question', answerJson: exact });
  expect(host.textContent).toContain('mcp/elicitation');
  if (question.content.kind !== 'question') throw new Error('fixture');
  const unavailable = { ...question, id: 'unattested', content: { ...question.content, answerContract: { kind: 'unavailable' as const, gap: 'question-validator' as const } } };
  await render(ready(unavailable));
  expect(host.textContent).toContain('validateur n’est pas attesté');
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});
it('sends an action refusal and a plan refusal as distinct decisions with exact comments', async () => {
  const request = humanFixture030({ content: { kind: 'actionApproval', title: 'Autoriser la publication ?', actionJson: '{ "command": "publish" }' } });
  transport.setCurrent(request); await render(ready(request)); await text('  Pas maintenant. ');
  expect(host.textContent).toContain('l’agent continue sans l’exécuter');
  await act(async () => host.querySelectorAll<HTMLButtonElement>('form button')[1].click());
  expect(transport.submissions[0].answer).toEqual({ kind: 'decision', decision: 'no', comment: '  Pas maintenant. ' });
  const plan = humanFixture030({ id: 'plan', content: { kind: 'plan', plan: '1. Relire\n2. Publier' } });
  transport.setCurrent(plan); await render(ready(plan));
  await act(async () => host.querySelectorAll<HTMLButtonElement>('form button')[1].click());
  expect(transport.submissions[1].answer).toEqual({ kind: 'decision', decision: 'no', comment: '' });
});
it('shows the exact native command and file scope before an action decision', async () => {
  const command = "printf 'before' # commentaire\nprintf 'AFTER' > /workspace/sentinel.txt";
  const file = '/workspace/two  spaces.txt';
  const cwd = '/workspace/directory\nname';
  const actionJson = JSON.stringify({ nativeRequest: { method: 'item/commandExecution/requestApproval', params: {
    kind: 'command', command, cwd,
    additionalPermissions: { fileSystem: { write: [file] } },
  } } });
  const request = humanFixture030({ content: { kind: 'actionApproval', title: '', actionJson } });
  transport.setCurrent(request); await render(ready(request));
  const summary = host.querySelector('[data-native-command-summary]')!;
  expect(summary.textContent).toContain('Uniquement pour cette commande');
  const values = summary.querySelectorAll('dd');
  expect(Array.from(values, value => value.textContent)).toEqual([command, file, cwd]);
  for (const value of values) expect(value.classList.contains('whitespace-pre-wrap')).toBe(true);
  expect(summary.textContent).toContain('Fichier');
  expect(summary.textContent).toContain('Dossier de travail');
  expect(summary.closest('details')).toBeNull();
  await act(async () => host.querySelectorAll<HTMLButtonElement>('form button')[1].click());
  expect(transport.submissions[0].answer).toEqual({ kind: 'decision', decision: 'no', comment: '' });
});
it('shows exact MCP tool arguments and submits a decision through the native request', async () => {
  const actionJson = '{"nativeRequest":{"method":"mcp/tool/requestApproval","params":{"server":"issues","tool":"lookup","arguments":{"number":9007199254740993,"filter":{"state":"open"}}}}}';
  const request = humanFixture030({ content: { kind: 'actionApproval', title: 'Allow lookup?', actionJson } });
  transport.setCurrent(request); await render(ready(request));
  const summary = host.querySelector('[data-native-mcp-summary]')!;
  expect(Array.from(summary.querySelectorAll('dd'), value => value.textContent)).toEqual([
    'issues', 'lookup', '{"number":9007199254740993,"filter":{"state":"open"}}',
  ]);
  expect(summary.closest('details')).toBeNull();
  await act(async () => host.querySelectorAll<HTMLButtonElement>('form button')[0].click());
  expect(transport.submissions[0].answer).toEqual({ kind: 'decision', decision: 'yes', comment: '' });
});
it('mounts large MCP arguments on demand and shows controls as escapes', async () => {
  const args = JSON.stringify({ value: 'x'.repeat(2 * 1024 * 1024) + '\u202eend-of-argument' });
  const actionJson = '{"nativeRequest":{"method":"mcp/tool/requestApproval","params":{"server":"issues","tool":"look\\nup","arguments":' + args + '}}}';
  const request = humanFixture030({ content: { kind: 'actionApproval', title: 'Allow lookup?', actionJson } });
  await render(ready(request));
  const summary = host.querySelector('[data-native-mcp-summary]')!;
  const toggle = summary.querySelector('button')!;
  expect(summary.textContent).toContain('look\\u000aup');
  expect(summary.querySelector('pre')!.textContent).toHaveLength(4097);
  expect(host.textContent).not.toContain('end-of-argument');
  await act(async () => toggle.click());
  expect(summary.querySelector('pre')!.textContent).toEndWith('\\u202eend-of-argument"}');
  await render(ready({ ...request, state: { kind: 'expired', resolution: resolutionFixture030({ reason: 'approvalTimeout', answer: null }) } }));
  expect(summary.querySelector('pre')).toBeNull();
  await act(async () => summary.querySelector('button')!.click());
  expect(summary.querySelector('pre')!.textContent).toEndWith('\\u202eend-of-argument"}');
});
it('restores every native terminal reason and response after remount without inventing an answer', async () => {
  const resolution = resolutionFixture030();
  const states: RunHumanState030[] = [
    { kind: 'resolved', receiptId: 's', resolution },
    { kind: 'consumed', receiptId: 's', resolutionReceiptId: 'r', resolution },
    { kind: 'expired', resolution: resolutionFixture030({ reason: 'answerTimeout', answer: { origin: 'automaticTimeout', answer: { kind: 'decision', decision: 'no', comment: '' }, receivedAtMs: '60000' } }) },
    { kind: 'expired', resolution: resolutionFixture030({ reason: 'approvalTimeout', answer: null }) },
    ...(['stop', 'revocation', 'workEnded'] as const).map(reason => ({ kind: 'cancelled' as const, resolution: resolutionFixture030({ reason, answer: null }) })),
    { kind: 'uncertain', receiptId: 's', phase: 'beforeResolution' },
    { kind: 'uncertain', receiptId: 's', phase: 'afterResolution', resolution },
  ];
  for (const state of states) {
    await render(ready(humanFixture030({ id: state.kind + ('resolution' in state ? state.resolution.reason : ''), state })));
    expect(host.textContent).not.toContain('agsdl.human030.');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    if ('resolution' in state) expect(host.querySelector('[data-human-reason]')).not.toBeNull();
    if ('resolution' in state && state.resolution.answer === null) expect(host.querySelector('[data-human-answer]')).toBeNull();
  }
});
it('does not infer expiration at zero, keeps paused budgets fixed, and marks retained data stale', async () => {
  const request = humanFixture030();
  if (request.clock.kind !== 'available') throw new Error('fixture');
  const zero = { ...request, clock: { kind: 'available' as const, value: { ...request.clock.value, observedAtMs: '90071992547409990000' } } };
  await render(ready(zero));
  const before = host.querySelector('[data-human-clock]')!.textContent;
  await render(ready({ ...zero }));
  expect(host.querySelector('[data-human-clock]')!.textContent).toBe(before);
  expect(host.textContent).toContain('En attente de votre réponse');
  expect(host.textContent).toContain('L’hôte détermine');
  await render({ kind: 'stale', revision: '0', retained: [request], refusal: { code: 'CONFLICT', message: '', currentRevision: null } });
  await choose('0');
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});
it('keeps unclassified requests and unavailable occurrence mappings readable without invented links', async () => {
  const request = humanFixture030({ occurrences: [{ workId: 'public-human-work', activation: { kind: 'unavailable', gap: 'human-occurrence-mapping' } }],
    content: { kind: 'unclassified', gap: 'human-purpose', content: { kind: 'approval', title: 'Finalité inconnue', description: 'Description exacte', message: 'Message exact', choices: ['yes', 'no'] } } });
  await render(ready(request));
  expect(host.textContent).toContain('Message exact');
  expect(host.textContent).toContain('Étape liée 1 : non disponible');
  expect(host.querySelector('article details p button')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(notification).not.toHaveBeenCalled();
});

it('does not replace a newer receipt with an older parent read and never labels an absent answer accepted', async () => {
  await render(); await choose('2'); await submit();
  expect(host.textContent).toContain('Réponse remise, décision en attente');
  await render(ready({ ...humanFixture030() }));
  expect(host.textContent).toContain('Réponse remise, décision en attente');
  const closed = humanFixture030({ revision: '2', state: { kind: 'expired', resolution: resolutionFixture030({ reason: 'approvalTimeout', answer: null }) } });
  await render(ready(closed));
  expect(host.textContent).toContain('Fermée sans réponse');
  expect(host.textContent).not.toContain('Réponse retenue pour cette demande');
});

it('uses read-only reconciliation after ambiguous delivery and failed read without a second submission', async () => {
  transport.setMode('uncertain'); transport.failReads(true);
  await render(); await choose('0'); await submit();
  expect(host.textContent).toContain('Une réponse a peut-être déjà été remise');
  await act(async () => root?.unmount()); root = undefined; host.remove(); await render();
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  transport.failReads(false);
  const refresh = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Actualiser l’état')!;
  await act(async () => refresh.click());
  await submit();
  expect(transport.submissions).toHaveLength(1);
});

it('keeps a refused request stale and disabled after remount until its announced revision is read', async () => {
  const storage = memoryDraftStorage030();
  const send = async (input: Parameters<typeof transport.submit>[0]) => {
    transport.submissions.push(input);
    return { kind: 'refused' as const, refusal: { code: 'REQUEST_CLOSED' as const, currentRevision: '2', message: 'Décision en révision 2.' } };
  };
  props.client = createHumanRequestClient030({ submit: send, read: transport.read, storage });
  await render(); await choose('1'); await text('Mon brouillon exact'); await submit();
  expect(host.textContent).toContain('Ces informations sont les dernières connues');
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  await act(async () => root?.unmount()); root = undefined; host.remove();
  props.client = createHumanRequestClient030({ submit: send, read: transport.read, storage });
  await render();
  expect(host.querySelector('textarea')!.value).toBe('Mon brouillon exact');
  expect(host.textContent).toContain('Ces informations sont les dernières connues');
  await submit();
  const refresh = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Actualiser l’état')!;
  await act(async () => refresh.click());
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(transport.submissions).toHaveLength(1);
  transport.setCurrent({ ...humanFixture030(), revision: '2' });
  await act(async () => refresh.click());
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
});

for (const kind of ['plan', 'question'] as const) {
  it(`keeps long ${kind} content exact inside a closed disclosure before the response controls`, async () => {
    const message = ('Contenu exact, à relire.\n').repeat(100);
    const description = ('Format exact de réponse.\n').repeat(80);
    const content = kind === 'plan' ? { kind, plan: message } : { kind, question: message, expectedResponse: description,
      answerContract: { kind: 'available' as const, value: { protocol: 'mcp/elicitation', schemaJson: '{}' } } };
    await render(ready(humanFixture030({ id: kind, content })));
    const form = host.querySelector('form')!;
    const details = form.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBeTruthy();
    expect(Array.from(details.querySelectorAll('p')).some(p => p.textContent === message)).toBe(true);
    if (kind === 'question') expect(Array.from(details.querySelectorAll('p')).some(p => p.textContent === description)).toBe(true);
    expect(form.querySelector('textarea')!.closest('details')).toBeNull();
    for (const button of form.querySelectorAll('button')) expect(button.closest('details')).toBeNull();
  });
}
