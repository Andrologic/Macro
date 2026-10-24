import { expect, test } from 'bun:test';
import type { ChatMessage } from '../types';
import { messageDisplayDate } from './chatHistoryDisplay';
import { sortMessagesChronologically } from '../stores/chat/chatMessageState';
import { portableArchiveBinding } from './contextCompaction';

const imported = (ordinal: string, date: string | null, timestamp = '1970-01-01T00:00:00.000Z'): ChatMessage => ({
  id: ordinal, task_id: '', conversation_id: 'c', role: 'user', content: 'Historical data', timestamp,
  portable_history: { version: 1, importKey: 'archive', manifest: 'a'.repeat(64), ordinal, displayDate: date },
});

test('imported order is independent of display dates and new local activity follows it', () => {
  const first = imported('0', '2099-01-01T00:00:00Z');
  const second = imported('1', '2000-01-01T00:00:00Z');
  const ordinary: ChatMessage = { id: 'new', task_id: '', conversation_id: 'c', role: 'user', content: 'Continue', timestamp: '1960-01-01T00:00:00Z' };
  expect(sortMessagesChronologically([ordinary, second, first]).map(m => m.id)).toEqual(['0', '1', 'new']);
  expect(messageDisplayDate(first)).toBe('2099-01-01T00:00:00Z');
  expect(messageDisplayDate(imported('2', null))).toBeNull();
  expect(messageDisplayDate({ ...ordinary, timestamp: 'legacy local date' })).toBe('legacy local date');
  for (const date of ['001', 'not a date', '2025-02-30T00:00:00Z', '2025-01-01T24:00:00Z']) expect(messageDisplayDate(imported('3', date))).toBeNull();
  expect(portableArchiveBinding([first, second])).toEqual({ version: 1, importKey: 'archive', manifest: 'a'.repeat(64) });
});
