import {
  connectArchiveOpen, connectArchivePage, connectArchiveMaterialize, connectArchiveRelease,
  type ArchiveOpenInput, type ArchiveReadHandle, type ArchivePage,
  type ArchiveMaterializeInput, type ArchiveBacking,
} from './ipc/connectArchive';
import { createLifecycleScope, LifecycleStoppedError, type LifecycleContext } from './lifecycleScope';
import { toServiceError } from './contracts/errors';

/** A display page ends on a real UTF-8 boundary. Only that precise native
 * range error may shorten the page; quota/integrity errors preserve the cursor. */
export async function readArchiveTextPage(session: ArchiveReaderSession, resourceUuid: string,
  start: string, bytes: string): Promise<ArchiveValue<ArchiveBacking>> {
  const from = BigInt(start), total = BigInt(bytes);
  let end = from + 65536n < total ? from + 65536n : total;
  for (let adjustment = 0; ; adjustment++) {
    try { return await session.materialize({ resourceUuid, use: 'renderText', range: { start, end: end.toString() } }); }
    catch (error) {
      if (adjustment >= 3 || end <= from || !toServiceError(error).message.includes('archive_invalid_utf8_range')) throw error;
      end--;
    }
  }
}

export async function readPreviousArchiveTextPage(session: ArchiveReaderSession, resourceUuid: string,
  end: string): Promise<ArchiveValue<ArchiveBacking>> {
  const to = BigInt(end);
  let start = to > 65536n ? to - 65536n : 0n;
  for (let adjustment = 0; ; adjustment++) {
    try { return await session.materialize({ resourceUuid, use: 'renderText', range: { start: start.toString(), end } }); }
    catch (error) {
      if (adjustment >= 3 || start >= to || !toServiceError(error).message.includes('archive_invalid_utf8_range')) throw error;
      start++;
    }
  }
}

/** The object and its native backing stay shared. Retaining does not copy bytes. */
export interface ArchiveValue<T> {
  readonly value: T;
  retain(): ArchiveValue<T>;
  release(): void;
}

const sessions = new Set<ArchiveReaderSession>();
const openings = new Set<{ conversationId: string; cancelled: boolean; work: Promise<unknown> }>();
let readers = createLifecycleScope();
let retirement: Promise<void> = Promise.resolve();
const retiring = new Set<(conversationId?: string) => void>();

export function onArchiveReadersRetiring(listener: (conversationId?: string) => void): () => void {
  retiring.add(listener);
  return () => { retiring.delete(listener); };
}

/** Called after the previous profile's retirement has been joined. */
export async function activateArchiveReaders(): Promise<void> {
  await retirement;
  if (!readers.isActive()) readers = createLifecycleScope();
}

/** Consumers first remove cached/rendered/context values, then join this owner. */
export function retireArchiveReaders(conversationId?: string): Promise<void> {
  // Renderers revoke their views here, then release after removing their DOM
  // and application copies. The join below still waits for those consumers.
  const failures: unknown[] = [];
  for (const listener of retiring) {
    try { listener(conversationId); } catch (error) { failures.push(error); }
  }
  if (!conversationId) readers.stop();
  const pending = [...openings].filter(opening => !conversationId || opening.conversationId === conversationId);
  pending.forEach(opening => { opening.cancelled = true; });
  const selected = [...sessions].filter(session => !conversationId || session.conversationId === conversationId);
  selected.forEach(session => session.close());
  const work = Promise.all([
    ...selected.map(session => session.drain()),
    ...pending.map(opening => opening.work.then(() => undefined, () => undefined)),
  ]).then(() => {
    if (failures.length) throw new AggregateError(failures, 'Archive consumer retirement failed.');
  });
  if (conversationId) return work;
  retirement = Promise.all([retirement, readers.drain(), work]).then(() => undefined);
  return retirement;
}

export class ArchiveReaderSession {
  private readonly scope = createLifecycleScope();
  private readonly values = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private readonly releaseRead: () => void;
  private finish?: () => void;
  private readonly finished: Promise<void>;
  private closing = false;
  readonly conversationId: string;

  private constructor(private readonly handle: ArchiveReadHandle) {
    this.conversationId = handle.conversationId;
    this.finished = new Promise(resolve => { this.finish = resolve; });
    sessions.add(this);
    this.releaseRead = readers.own(() => this.close());
  }

  static open(input: ArchiveOpenInput, lifecycle?: LifecycleContext): Promise<ArchiveReaderSession> {
    const owner = readers;
    owner.assertActive();
    lifecycle?.assertActive();
    const opening = { conversationId: input.conversationId, cancelled: false, work: Promise.resolve() as Promise<unknown> };
    const work = owner.track((async () => {
      const handle = await connectArchiveOpen(input);
      // IPC cancellation does not cancel the native SQLite reader. Join the
      // reply and release its real handle even if the application retired.
      if (!owner.isActive() || opening.cancelled || (lifecycle !== undefined && !lifecycle.isActive())) {
        await connectArchiveRelease({ id: handle.readId });
        throw new LifecycleStoppedError();
      }
      const session = new ArchiveReaderSession(handle);
      if (lifecycle) {
        const close = () => session.close();
        lifecycle.signal.addEventListener('abort', close, { once: true });
        session.scope.own(() => lifecycle.signal.removeEventListener('abort', close));
      }
      return session;
    })());
    opening.work = work;
    openings.add(opening);
    void work.then(() => openings.delete(opening), () => openings.delete(opening));
    return work;
  }

  private own<T>(value: T, id: string): ArchiveValue<T> {
    let data: T | undefined = value;
    let refs = 0;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.values.add(done);
    const make = (): ArchiveValue<T> => {
      refs++;
      let released = false;
      return {
        get value() {
          if (released || data === undefined) throw new LifecycleStoppedError();
          return data;
        },
        retain: () => {
          if (released || data === undefined) throw new LifecycleStoppedError();
          return make();
        },
        release: () => {
          if (released) return;
          released = true;
          if (--refs !== 0) return;
          data = undefined;
          const release = connectArchiveRelease({ id }).catch(error => { this.failures.push(error); });
          void release.finally(() => { this.values.delete(done); finish(); });
        },
      };
    };
    return make();
  }

  private read<T>(work: () => Promise<T>, id: (value: T) => string): Promise<ArchiveValue<T>> {
    this.scope.assertActive();
    return this.scope.track((async () => {
      const value = await work();
      if (!this.scope.isActive()) {
        await connectArchiveRelease({ id: id(value) });
        throw new LifecycleStoppedError();
      }
      return this.own(value, id(value));
    })());
  }

  page(cursorId: string | null, limit = 16): Promise<ArchiveValue<ArchivePage>> {
    return this.read(() => connectArchivePage({ readId: this.handle.readId, cursorId, limit }), page => page.pageId);
  }

  materialize(input: Omit<ArchiveMaterializeInput, 'readId'>): Promise<ArchiveValue<ArchiveBacking>> {
    return this.read(() => connectArchiveMaterialize({ ...input, readId: this.handle.readId }), backing => backing.backingId);
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.scope.stop();
    this.releaseRead();
    // Do not refund pages/backings still held by a cache, preview or request.
    void (async () => {
      try {
        await this.scope.drain();
        while (this.values.size) await Promise.all([...this.values]);
        await connectArchiveRelease({ id: this.handle.readId });
      } catch (error) { this.failures.push(error); }
      finally { sessions.delete(this); this.finish?.(); }
    })();
  }

  async drain(): Promise<void> {
    await this.finished;
    if (this.failures.length) throw new AggregateError(this.failures, 'Archive reader retirement failed.');
  }
}
