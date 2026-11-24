import { expect, test } from 'bun:test';
import { snapshotLegacyLocalStorage } from './legacyLocalStorage';

test('captures exact legacy records and distinguishes empty storage from an unavailable origin', () => {
  const rows = Object.entries({
    'macro_architect_plan:feature/sample:id': '{ "id": "id" }',
    'macro_architect_plan_index:feature/sample': '{"version":2,"plans":[]}',
    'macro_architect_plan_chat:feature/sample:id': 'raw\r\n',
    'unrelated-setting': 'ignored',
  });
  expect(snapshotLegacyLocalStorage({
    length: rows.length,
    key: (index) => rows[index]?.[0] ?? null,
    getItem: (key) => rows.find(([candidate]) => key === candidate)?.[1] ?? null,
  })).toEqual({ state: 'snapshot', value: Object.fromEntries(rows.slice(0, 3)) });

  const empty = { length: 0, key: () => null, getItem: () => null };
  expect(snapshotLegacyLocalStorage(empty)).toEqual({ state: 'snapshot', value: {} });
  expect(snapshotLegacyLocalStorage({
    ...empty,
    get length(): number { throw new Error('denied'); },
  })).toEqual({ state: 'unavailable', value: 'Error: denied' });
});
