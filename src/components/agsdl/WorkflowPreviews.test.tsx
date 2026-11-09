import i18n from '../../i18n';
import { blockDetails } from '../../services/agsdl/blockDetails';
import { projectViewer030 } from '../../services/agsdl/viewer030';
import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkflowBlockPreview, WorkflowEdgePreview } from './WorkflowPreviews';

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => { await i18n.changeLanguage('en'); root?.unmount(); }); host?.remove(); });
async function render(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

it('lists configuration rows in order and keeps expressions literal', async () => {
  const view = await render(<WorkflowBlockPreview details={[
    { key: 'instructions', values: ['Review the change.'] },
    { key: 'test', values: ['data.exitCode = 0'] },
    { key: 'effect', values: ['unknown'] },
  ]} />);
  expect(view.querySelector('.agsdl-preview-lead')?.textContent).toBe('Review the change.');
  const rows = [...view.querySelectorAll('.agsdl-preview-list > div')];
  expect(rows).toHaveLength(2);
  expect(rows[0].querySelector('dd')?.className).toBe('is-literal');
  expect(rows[0].textContent).toContain('data.exitCode = 0');
});

it('describes a connection by the choice that takes it, without naming its target', async () => {
  const view = await render(<WorkflowEdgePreview sourceTitle="Review" sourcePerformer="Reviewer"
    connection={{ id: 'e', source: 'review', target: 'publish', label: 'accept', dependency: false, transfers: ['completion'] }} />);
  expect(view.textContent).toContain('Reviewer');
  expect(view.textContent).toContain('accept');
  expect(view.textContent).not.toContain('publish');
});

it('explains fan-out and inherited recovery without exposing source syntax in the preview', async () => {
  const view = await render(<WorkflowEdgePreview sourceTitle="Review" connection={{ id:'fanout',source:'a',target:'b',label:'onError',dependency:false,
    route030:{path:'/flow/onError',sourcePath:'/flow/steps/a',targetKind:'step',role:'error',inherited:true,eachJson:'["error","details"]',via:['/flow/onError']}, transfers:['resources.error'] }} />);
  expect(view.textContent).toContain('For each item');
  expect(view.textContent).toContain('inherited');
  expect(view.textContent).not.toContain('resources.error');
  expect(view.textContent).not.toContain('/flow/onError');
});

it('separates the quorum decision from when wait, finish and stop allow continuation', async () => {
  await render(null);
  for (const language of ['en', 'fr']) {
    await act(async () => { await i18n.changeLanguage(language); });
    for (const threshold of [1, 2]) for (const remaining of ['wait', 'finish', 'stop']) {
      const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'decision', agents: {}, flow: { entry: 'vote', steps: {
        vote: { type: 'join', quorum: { count: threshold, accept: ['approve'] }, remaining },
      } } });
      const card = projectViewer030(source).graphs[0].cards[0];
      await act(async () => root!.render(<WorkflowBlockPreview card={card} details={blockDetails(card, [])} />));
      const rows = [...host.querySelectorAll('.agsdl-preview-list > div')];
      expect(rows[0].querySelector('dd')?.textContent).toStartWith(language === 'fr' ? 'Décider dès' : 'Decide as soon');
      const continuation = rows.find(row => row.querySelector('dt')?.textContent === (language === 'fr' ? 'Autres branches' : 'Other branches'))!.textContent;
      expect(continuation).toContain(language === 'fr' ? 'Après la décision' : 'After the decision');
      if (remaining === 'stop') expect(continuation).toContain(language === 'fr' ? 'une fois leur arrêt effectif' : 'once they have actually stopped');
      if (remaining === 'wait') expect(continuation).toContain(language === 'fr' ? 'terminer, puis poursuivre' : 'finish, then continue');
      if (remaining === 'finish') expect(continuation).toContain(language === 'fr' ? 'poursuivre immédiatement' : 'continue immediately');
    }
  }
});

it('warns that the failure after the declared tolerance immediately fails the group', async () => {
  const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'tolerance', agents: {}, flow: { entry: 'gather', steps: {
    gather: { type: 'join', failures: 'keep', maxFailures: 1 },
  } } });
  const card = projectViewer030(source).graphs[0].cards[0];
  await act(async () => { await i18n.changeLanguage('fr'); });
  const view = await render(<WorkflowBlockPreview card={card} details={blockDetails(card, [])} />);
  expect(view.textContent).toContain('Limite d’échecs tolérés : 1.');
  expect(view.textContent).toContain('Tout échec supplémentaire fait échouer le groupe immédiatement.');
  expect(view.querySelector('details')?.open).toBe(false);
});

it('distinguishes an enclosing recovery from a declared composition output in English and French', async () => {
  await render(null);
  for (const language of ['en', 'fr']) {
    await act(async () => { await i18n.changeLanguage(language); });
    for (const inheritedError of [true, false]) {
      await act(async () => root!.render(<WorkflowEdgePreview sourceTitle="Review" connection={{
        id: 'via', source: 'inside', target: 'outside', label: inheritedError ? 'onError' : 'done', dependency: false,
        route030: { path: inheritedError ? '/flow/onError' : '/flow/steps/review/next/done', sourcePath: '/compositions/review/steps/check',
          targetKind: 'step', role: inheritedError ? 'error' : 'normal', inherited: inheritedError,
          via: inheritedError ? ['/flow/onError'] : ['/compositions/review/steps/check/next', '/flow/steps/review/next/done'] },
      }} />));
      const explanation = [...host.querySelectorAll('dd')][1].textContent;
      expect(explanation).toContain(inheritedError
        ? language === 'fr' ? 'remonte vers un recours' : 'propagates to a recovery route'
        : language === 'fr' ? 'sortie déclarée' : 'declared subprocess output');
      if (inheritedError) expect(explanation).not.toContain(language === 'fr' ? 'sortie' : 'output');
      expect(explanation).not.toContain('/flow/');
    }
  }
});
