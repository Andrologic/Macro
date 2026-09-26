import type { ChatMessage } from '../../src/types';

export const fixtureSizes = [100, 1_000, 10_000] as const;
export const content = 'synthetic message '.padEnd(256, 'x');
export const timestamp = '2026-01-01T00:00:00.000Z';
export function messages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `message-${String(i).padStart(6, '0')}`, task_id: 'fixture-task',
    conversation_id: 'fixture-conversation', role: i % 2 ? 'assistant' : 'user',
    content, timestamp,
  }));
}
export function terminal(count: number) {
  const line = 'synthetic terminal match '.padEnd(120, '.');
  return { buffer: { active: {
    length: count,
    getLine: () => ({ translateToString: () => line }),
  } } };
}
