import { test, expect } from 'bun:test';
import { historyFixture, measureHistory, resourceCycles } from './history-resources';

test('history measurements execute production mapping and preserve indexed message identity', async () => {
  expect(historyFixture(3, false).every(row => row.role === 'user' && row.content.length === 256)).toBe(true);
  const plain = await measureHistory(3, false, 0, 2);
  const nested = await measureHistory(3, true, 0, 2);
  expect(nested.jsonBytes).toBeGreaterThan(plain.jsonBytes);
  expect(plain.retainedState).toEqual({ uniqueMessages: 3, messageArrayReferences: 6, idIndexEntries: 3, contentCopiesInIndexes: 0 });
  expect(nested.loadConversationMessages.count).toBe(2);
});

test('long-cycle smoke checks real owner release and reports intentional run retention', async () => {
  const result = await resourceCycles(8, 4);
  expect(result.checks).toEqual({ settled: 8, releasedStreams: 8, deliveredEvents: 8,
    cancelledTurns: 4, pendingOwnedTimers: 0, projectedStates: 0, activeStreamRegistry: 0, pendingSubagentTimers: 0 });
  expect(result.snapshotsAfterDispose).toBe(8);
  expect(result.snapshotsAfterRelease).toBe(0);
  expect(result.retainedHistoryMessages).toBe(100);
  expect(result.checkpoints.length).toBe(5);
});
