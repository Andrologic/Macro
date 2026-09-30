import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { benchmark } from './stats';
import { content, timestamp } from './fixtures';

const repository = readFileSync(new URL('../../src-tauri/src/db/repository.rs', import.meta.url), 'utf8');
// Fail closed when the Rust query layout changes; never silently benchmark stale SQL.
export function productSql(functionName: string) {
  const start = repository.indexOf(`pub async fn ${functionName}(`);
  if (start < 0) throw new Error(`Missing product function ${functionName}`);
  const end = repository.indexOf('\npub async fn ', start + 1);
  const body = repository.slice(start, end < 0 ? undefined : end);
  const match = body.match(/sqlx::query\(\s*r#"([\s\S]*?)"#/);
  if (!match) throw new Error(`Missing literal SQL in ${functionName}`);
  return match[1];
}
export function sqliteBaseline(count: number) {
  // The statement benchmark needs the message schema used by the current queries,
  // without pretending to exercise the full native migration workflow.
  const schema = ['001_initial.sql', '006_generation_attempts.sql']
    .map((name) => readFileSync(new URL(`../../src-tauri/src/db/migrations/${name}`, import.meta.url), 'utf8'))
    .join('\n');
  const readSql = productSql('list_messages');
  const writeSql = productSql('create_message');
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(schema);
    db.run('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ['fixture-conversation', 'Synthetic', timestamp, timestamp]);
    const insert = db.prepare(writeSql);
    const params = (id: string) => [id, 'fixture-conversation', null, 'user', content,
      timestamp, null, null, null, null, null, null, null, null];
    db.transaction(() => {
      for (let i = 0; i < count; i++) insert.run(...params(`message-${String(i).padStart(6, '0')}`));
    })();
    const read = db.prepare(readSql);
    if (read.all('fixture-conversation').length !== count) throw new Error('Invalid SQLite fixture');
    const readResult = benchmark(() => read.all('fixture-conversation'));
    // Rollback keeps the fixture size fixed. This measures statement + transaction,
    // not create_message's metadata refresh, SQLx mapping, disk durability or IPC.
    const writeResult = benchmark(() => {
      db.exec('BEGIN');
      try { insert.run(...params('new-message')); } finally { db.exec('ROLLBACK'); }
    });
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    return { count, sqliteVersion: db.query('SELECT sqlite_version() AS version').get(),
      schemaSha256: hash(schema), readSqlSha256: hash(readSql), writeSqlSha256: hash(writeSql),
      read: readResult, insertRollback: writeResult };
  } finally { db.close(); }
}
