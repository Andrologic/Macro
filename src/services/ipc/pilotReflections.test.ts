import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { parseToolTracesJson } from '../toolTraceState';
import type { PilotReflectionMessageRead } from '../../types/generated/ipc';

const nativeSource = readFileSync(new URL('../../../src-tauri/src/db/pilot_reflections.rs', import.meta.url), 'utf8');
const sql = (name: string): string => {
  const match = nativeSource.match(new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`));
  if (!match) throw new Error(`Native SQL missing: ${name}`);
  return match[1];
};
const byteLimit = Number(nativeSource.match(/const SOURCE_MAX_BYTES: i64 = (.*);/)?.[1].split('*').map(Number).reduce((a, b) => a * b));
const anchorLimit = Number(nativeSource.match(/const MAX_TOOL_ANCHORS: usize = (\d+);/)?.[1]);
const sizeSql = sql('SOURCE_SIZE_SQL');
const anchorsSql = sql('TOOL_ANCHORS_SQL');
const anchorSizeSql = sql('TOOL_ANCHOR_SIZE_SQL') + anchorsSql + ')';
const selectSql = sql('SOURCE_SELECT_SQL');
const ambiguitySql = sql('TOOL_AMBIGUITY_SQL');

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); mock.restore(); });
function database(content = '<think>é🙂</think>', tools: string | null = null) {
  const db = new Database(':memory:'); databases.push(db);
  // Intentionally no provider columns: the exact queries must work without them.
  db.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, scope_mode TEXT NOT NULL, task_id TEXT); INSERT INTO conversations VALUES ('chat', 'Chat', NULL)");
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, turn_id TEXT, role TEXT, content TEXT, hidden_context TEXT, tool_traces_json TEXT)');
  db.query('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)').run('assistant', 'chat', 'turn', 'assistant', content, 'private-context', tools);
  db.query('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)').run('user', 'chat', 'turn', 'user', '<think>user</think>', null, null);
  return db;
}

describe('native reflection SQL, executed verbatim on synthetic SQLite records', () => {
  it('binds both identifiers and assistant role in every query', () => {
    const db = database();
    for (const query of [sizeSql, anchorsSql, selectSql]) {
      expect(db.query(query).all('other', 'assistant')).toEqual([]);
      expect(db.query(query).all('chat', 'user')).toEqual([]);
      expect(db.query(query).all('chat', "' OR 1=1 --")).toEqual([]);
    }
    expect(db.query(anchorSizeSql).get('other', 'assistant')).toEqual({ anchor_bytes: 0, anchor_count: 0 });
  });

  it('exports raw content/turn and a flag while retaining all private fields', () => {
    const content = '  <think>raw</think>\n[quick-replies]\n- one\n- two\n- three\n[/quick-replies] ';
    const db = database(content);
    expect(db.query(selectSql).get('chat', 'assistant')).toEqual({
      id: 'assistant', conversation_id: 'chat', turn_id: 'turn', role: 'assistant', content, has_hidden_context: 1, conversation_scope_mode: 'Chat', conversation_task_id: null,
    });
    db.query('UPDATE messages SET hidden_context = ? WHERE id = ?').run('\0private', 'assistant');
    expect((db.query(selectSql).get('chat', 'assistant') as { has_hidden_context: number }).has_hidden_context).toBe(1);
    db.query('UPDATE messages SET hidden_context = NULL WHERE id = ?').run('assistant');
    expect((db.query(selectSql).get('chat', 'assistant') as { has_hidden_context: number }).has_hidden_context).toBe(0);
  });

  it('reads the durable scope/task binding and rejects a missing conversation', () => {
    const db = database();
    db.query('UPDATE conversations SET scope_mode = ?, task_id = ? WHERE id = ?').run('Implement', 'task-one', 'chat');
    const message = db.query(selectSql).get('chat', 'assistant') as { conversation_scope_mode: string; conversation_task_id: string };
    expect(message.conversation_scope_mode).toBe('Implement');
    expect(message.conversation_task_id).toBe('task-one');
    db.query('DELETE FROM conversations WHERE id = ?').run('chat');
    expect(db.query(selectSql).get('chat', 'assistant')).toBeNull();
    expect(db.query(sizeSql).get('chat', 'assistant')).toBeNull();
  });

  it('uses the same isToolTrace filters as history for synthetic mixed metadata', () => {
    const raw = JSON.stringify([
      { tool_call_id: '', tool_name: '', status: 'done', visible_offset: null },
      { tool_call_id: 'call', tool_name: 'read', status: 'running', visible_offset: -2.5 },
      { tool_call_id: 'call', tool_name: 'read', status: 'denied' },
      { tool_call_id: 'call', tool_name: 'read', status: 'pending_approval', visible_offset: 100 },
      { tool_call_id: 5, tool_name: 'read', status: 'done' },
      { tool_call_id: 'call', tool_name: false, status: 'done' },
      { tool_call_id: 'call', tool_name: 'read', status: 'DONE' },
      { tool_call_id: 'call', tool_name: 'read', status: null },
      {}, [], null, 5, 'text', true,
    ]);
    const db = database('', raw);
    const anchors = (db.query(anchorsSql).all('chat', 'assistant') as { anchor_json: string }[]).map((row) => JSON.parse(row.anchor_json));
    expect(anchors).toEqual((parseToolTracesJson(raw) ?? []).map(({ tool_call_id, tool_name, status, visible_offset }) => ({ tool_call_id, tool_name, status, visible_offset: visible_offset ?? null })));
  });

  it('preserves null and malformed offset JSON types for native validation', () => {
    for (const offset of [null, '3', true, false, {}, [], 2.5, -1]) {
      const raw = JSON.stringify([{ tool_call_id: 'call', tool_name: 'read', status: 'done', visible_offset: offset }]);
      const db = database('', raw);
      const rows = db.query(anchorsSql).all('chat', 'assistant') as { anchor_json: string }[];
      expect(JSON.parse(rows[0].anchor_json).visible_offset).toEqual(offset);
    }
    const db = database('', '[{"tool_call_id":"call","tool_name":"read","status":"done"}]');
    expect(JSON.parse((db.query(anchorsSql).get('chat', 'assistant') as { anchor_json: string }).anchor_json).visible_offset).toBeNull();
  });

  it('retains duplicate relevant JSON keys whose SQLite interpretation differs from JSON.parse', () => {
    for (const key of ['tool_call_id', 'tool_name', 'status', 'visible_offset']) {
      const raw = `[{"tool_call_id":"call","tool_name":"read","status":"done","visible_offset":0,"${key}":${key === 'visible_offset' ? '3' : '"other"'}}]`;
      const db = database('', raw);
      expect(Object.values(db.query(ambiguitySql).get('chat', 'assistant') as Record<string, number>)).toEqual([1]);
    }
    const db = database('', '[null, 5, "string", {"tool_call_id":"call","tool_name":"read","status":"done","arguments":{"x":1,"x":2}}]');
    expect(Object.values(db.query(ambiguitySql).get('chat', 'assistant') as Record<string, number>)).toEqual([0]);
  });

  it('selects only valid anchors in stored order, without arguments/results/details', () => {
    const db = database('<think>é🙂</think>', JSON.stringify([
      { tool_call_id: 'later', tool_name: 'read', status: 'done', visible_offset: 16, arguments: { secret: 'private' }, result: '<think>result</think>', detail: 'private' },
      { tool_call_id: 'ignored', tool_name: 'read', status: 'invalid' },
      { tool_call_id: 'earlier', tool_name: 'write', status: 'pending_approval', visible_offset: 0 },
      null, 'invalid', { tool_name: 'read', status: 'done' },
    ]));
    const rows = db.query(anchorsSql).all('chat', 'assistant') as { anchor_json: string }[];
    expect(rows.map((row) => JSON.parse(row.anchor_json))).toEqual([
      { tool_call_id: 'later', tool_name: 'read', status: 'done', visible_offset: 16 },
      { tool_call_id: 'earlier', tool_name: 'write', status: 'pending_approval', visible_offset: 0 },
    ]);
    expect(db.query(anchorSizeSql).get('chat', 'assistant')).toEqual({
      anchor_count: 2, anchor_bytes: rows.reduce((total, row) => total + Buffer.byteLength(row.anchor_json), 0),
    });
    expect(JSON.stringify(rows)).not.toContain('private');
  });

  it('matches history parsing for null, malformed and non-array tool metadata', () => {
    for (const raw of [null, '', 'bad-json', '{}', 'null', '[null,5,"string",true]']) {
      const db = database('<think>visible</think>', raw);
      expect(db.query(anchorsSql).all('chat', 'assistant')).toEqual([]);
      expect(db.query(anchorSizeSql).get('chat', 'assistant')).toEqual({ anchor_bytes: 0, anchor_count: 0 });
    }
  });

  it('preflights UTF-8, identifiers and minimal metadata with an inclusive 1 MiB limit', () => {
    const db = database('é'.repeat(byteLimit / 2));
    let sizes = db.query(sizeSql).get('chat', 'assistant') as { source_bytes: number; tool_scan_bytes: number; metadata_bytes: number };
    expect(sizes.source_bytes).toBe(byteLimit);
    expect(sizes.metadata_bytes).toBe(Buffer.byteLength('assistantchatturnChat'));
    db.query('UPDATE messages SET content = content || ? WHERE id = ?').run('é', 'assistant');
    sizes = db.query(sizeSql).get('chat', 'assistant') as typeof sizes;
    expect(sizes.source_bytes).toBe(byteLimit + 2);
    db.query('UPDATE messages SET tool_traces_json = ? WHERE id = ?').run('x'.repeat(byteLimit + 1), 'assistant');
    expect((db.query(sizeSql).get('chat', 'assistant') as typeof sizes).tool_scan_bytes).toBe(byteLimit + 1);
  });

  it('measures minimal metadata separately from raw content against the 64 KiB host budget', () => {
    const db = database('');
    db.query('UPDATE conversations SET task_id = ? WHERE id = ?').run('é'.repeat(32768), 'chat');
    const size = db.query(sizeSql).get('chat', 'assistant') as { metadata_bytes: number };
    expect(size.metadata_bytes).toBe(65536 + Buffer.byteLength('assistantchatturnChat'));
    expect(size.metadata_bytes).toBeGreaterThan(64 * 1024);
    const tool = { tool_call_id: 'call', tool_name: 'é'.repeat(250), status: 'done', visible_offset: 0 };
    db.query('UPDATE conversations SET task_id = NULL WHERE id = ?').run('chat');
    db.query('UPDATE messages SET tool_traces_json = ? WHERE id = ?').run(JSON.stringify(Array.from({ length: anchorLimit }, () => tool)), 'assistant');
    const anchors = db.query(anchorSizeSql).get('chat', 'assistant') as { anchor_bytes: number };
    expect(anchors.anchor_bytes).toBeGreaterThan(64 * 1024);
  });

  it('detects an anchor overflow while fetching at most the sentinel count', () => {
    const tool = { tool_call_id: 'call', tool_name: 'read', status: 'done' };
    const db = database('', JSON.stringify(Array.from({ length: 1000 }, () => tool)));
    expect(db.query(anchorsSql).all('chat', 'assistant')).toHaveLength(anchorLimit + 1);
    expect((db.query(anchorSizeSql).get('chat', 'assistant') as { anchor_count: number }).anchor_count).toBe(anchorLimit + 1);
  });

  it('keeps size checks and fetch on one SQLite snapshot', () => {
    const db = database();
    db.exec('BEGIN');
    expect(db.query(sizeSql).get('chat', 'assistant')).not.toBeNull();
    expect(db.query(anchorSizeSql).get('chat', 'assistant')).toEqual({ anchor_bytes: 0, anchor_count: 0 });
    expect(db.query(selectSql).get('chat', 'assistant')).not.toBeNull();
    db.exec('ROLLBACK');
    const transaction = nativeSource.slice(nativeSource.indexOf('pub async fn get_pilot_reflection_message('), nativeSource.indexOf('#[cfg(test)]'));
    expect(transaction.match(/pool.begin\(\)/g)).toHaveLength(1);
    expect(transaction).not.toMatch(/fetch_(?:one|optional|all)\(pool\)/);
    expect(transaction.indexOf('source_sizes_within_limits(source_bytes, tool_scan_bytes, metadata_bytes, 0, 0)')).toBeLessThan(transaction.indexOf('sqlx::query(TOOL_ANCHORS_SQL)'));
    expect(transaction.indexOf('anchor_bytes,')).toBeLessThan(transaction.indexOf('sqlx::query(SOURCE_SELECT_SQL)'));
  });
});

it('passes both identities to the typed native reader and preserves explicit states', async () => {
  const result: PilotReflectionMessageRead = { state: 'withheld', message: null };
  const invoke = mock(async () => result);
  mock.module('../tauriRuntimeBridge', () => ({ invoke }));
  const { getPilotReflectionMessage } = await import('./conversationManagement');
  expect(await getPilotReflectionMessage('chat', 'assistant')).toEqual(result);
  expect(invoke).toHaveBeenCalledWith('db_get_pilot_reflection_message', { conversationId: 'chat', messageId: 'assistant' });
});
