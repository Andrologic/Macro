import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import { createDeferred } from '../../test-utils/deferred';
import { createTranslationMock, installReactI18nextMock } from '../../test-utils/reactI18nextMock';
import type { QueuedSubmissionPreview } from '../../stores/chat/chatQueuedSubmissionRuntime';
import fr from '../../i18n/locales/fr.json';

installReactI18nextMock(createTranslationMock(Object.fromEntries(Object.entries(fr.chat).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [`chat.${key}`, value]))));
const remove = mock(async (_id: string) => {});
const store = create<{ queuedSubmissionPreviews: QueuedSubmissionPreview[]; removeQueuedSubmission: typeof remove }>(() => ({ queuedSubmissionPreviews: [], removeQueuedSubmission: remove }));
mock.module('../../stores/useChatStore', () => ({ useChatStore: store }));
const { QueuedMessagesPanel } = await import('./QueuedMessagesPanel');
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  remove.mockReset(); remove.mockImplementation(async () => {});
  store.setState({ queuedSubmissionPreviews: [] });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const buttons = () => Array.from(container.querySelectorAll('button'));
const render = () => act(() => root.render(<QueuedMessagesPanel conversationId="a" />));

it('updates the selected conversation queue without revealing other conversation messages', () => {
  render(); expect(container.textContent).toBe('');
  act(() => store.setState({ queuedSubmissionPreviews: [
    { id: 'first', conversationId: 'a', content: 'Instruction visible', state: 'waiting' },
    { id: 'other', conversationId: 'b', content: 'Autre conversation', state: 'waiting' },
    { id: 'sending', conversationId: 'a', content: 'Instruction en cours', state: 'sending' },
  ] }));
  expect(container.textContent).toContain('Messages en attente · 2');
  expect(container.textContent).not.toContain('Autre conversation');
  expect(container.textContent).toContain(fr.chat.stopQueueDescription);
  expect(buttons()[0].disabled).toBe(false);
  expect(buttons()[1].disabled).toBe(true);
  expect(container.textContent).toContain('Envoi en cours…');
});

it('guards concurrent removal and keeps the message visible after a persistence failure', async () => {
  const result = createDeferred<void>();
  remove.mockImplementationOnce(() => result.promise.then(() => { throw new Error('Enregistrement impossible'); }));
  store.setState({ queuedSubmissionPreviews: [{ id: 'first', conversationId: 'a', content: 'Instruction conservée', state: 'waiting' }] });
  render();
  act(() => { buttons()[0].click(); buttons()[0].click(); });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith('first');
  expect(buttons()[0].disabled).toBe(true);
  await act(async () => { result.resolve(); await Promise.resolve(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enregistrement impossible');
  expect(container.textContent).toContain('Instruction conservée');
  expect(buttons()[0].disabled).toBe(false);
});
