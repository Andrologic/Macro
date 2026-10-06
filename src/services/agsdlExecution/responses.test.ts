import { describe, expect, it } from 'bun:test';
import { ExactResponseCollection } from './responses';
import { contextFixture, id, json } from './conformanceFixtures';
import { encode } from './exact';
import type { ExecutionContext, ProviderAttemptId, Sequence, TypedPublication, VisibleResponseMessage } from './contracts';

const context = contextFixture();
const interfaceJson = json('{"outputMediaTypes":["text/plain","application/json"],"results":{"report":{"required":true,"mediaTypes":["application/json"],"valueSchema":{"type":"integer","enum":[9007199254740993]}}}}');
const stepJson = json('{"type":"agent","agent":"worker","decision":{"binding":"publication","choices":["done","retry"]},"next":{"done":[],"retry":[]}}');
const contractJson = encode({ protocol: 'macro-agsdl-publication/1', registryVersion: context.registryVersion, agent: 'worker', step: ['work'], interface: { outputMediaTypes: ['text/plain', 'application/json'], results: { report: { required: true, mediaTypes: ['application/json'], valueSchema: { type: 'integer', enum: [] } } } }, choices: ['done', 'retry'], decisionBinding: {} }).replace('"enum":[]', '"enum":[9007199254740993]') as typeof interfaceJson;
function collector(publication = true, providerAttempts: readonly ProviderAttemptId[] = [id('attempt')], capturedContext: ExecutionContext = context) {
  return new ExactResponseCollection({ context: capturedContext, providerAttempts, interfaceJson: publication ? interfaceJson : json('{}'), stepJson: publication ? stepJson : json('{"type":"agent","agent":"worker"}'), publicationContractJson: publication ? contractJson : null });
}
const message = (sequence = '1', messageId = 'm1', textParts = ['visible']): VisibleResponseMessage => ({ context, providerAttemptId: id('attempt'), sequence: id(sequence), messageId: id(messageId), textParts });
const publication = (sequence = '2', changes: Partial<TypedPublication> = {}): TypedPublication => ({ context, providerAttemptId: id('attempt'), publicationId: 'publication-1', sequence: id(sequence), contractJson, resultsJson: json('{"report":{"value":9007199254740993.0,"mediaType":"application/json"}}'), choice: 'done', ...changes });
describe('attributed ordered response collection', () => {
  it('assembles in emission order after network reordering, with exact empty/LF rules', async () => {
    const collection = collector(false);
    await collection.append(message('4', 'm4', ['D\n']));
    await collection.append(message('1', 'm1', ['A', 'B']));
    await collection.append(message('3', 'm3', ['\nC']));
    await collection.append(message('2', 'm2', []));
    expect((await collection.close(context, id('4'))).text).toBe('AB\n\nC\nD\n');
  });
  it('deduplicates identical transmissions and refuses changed identity, sequence or attempt', async () => {
    const collection = collector(false);
    expect(await collection.append(message())).toBe('accepted');
    expect(await collection.append(message())).toBe('duplicate');
    for (const changed of [message('1', 'm1', ['different']), message('2', 'm1'), message('1', 'm2'), { ...message('2', 'm2'), providerAttemptId: id<'providerAttempt'>('unknown') }]) await expect(collection.append(changed)).rejects.toThrow('');
    expect((await collection.close(context, id('1'))).text).toBe('visible');
  });
  it('requires an explicit registered attempt for every Message, including malformed runtime events', async () => {
    const omitted = { ...message() };
    delete (omitted as { providerAttemptId?: ProviderAttemptId }).providerAttemptId;
    const inherited = Object.assign(Object.create({ providerAttemptId: id('attempt') }), omitted);
    const invalid = [omitted, inherited, { ...message(), providerAttemptId: undefined }, { ...message(), providerAttemptId: id('') }, { ...message(), providerAttemptId: id('unknown') }];
    for (const attempts of [[id<'providerAttempt'>('attempt')], []]) {
      for (const event of invalid) {
        const collection = collector(false, attempts);
        await expect(collection.append(event as VisibleResponseMessage)).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/providerAttemptId' });
        expect((await collection.close(context, id('0'))).text).toBe('');
      }
    }
    const empty = collector(false, []);
    await expect(empty.append(message())).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/providerAttemptId' });
    expect((await empty.close(context, id('0'))).text).toBe('');
  });
  it('requires an explicit registered attempt for every typed publication', async () => {
    const omitted = { ...publication('1') };
    delete (omitted as { providerAttemptId?: ProviderAttemptId }).providerAttemptId;
    const inherited = Object.assign(Object.create({ providerAttemptId: id('attempt') }), omitted);
    const invalid = [omitted, inherited, publication('1', { providerAttemptId: undefined }), publication('1', { providerAttemptId: id('') }), publication('1', { providerAttemptId: id('unknown') })];
    for (const attempts of [[id<'providerAttempt'>('attempt')], []]) {
      for (const event of invalid) {
        const collection = collector(true, attempts);
        await expect(collection.publish(event as TypedPublication)).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/providerAttemptId' });
        await expect(collection.close(context, id('0'))).rejects.toMatchObject({ code: 'OUTPUT_CONSTRAINT' });
        if (attempts.length) {
          expect(await collection.publish(publication('1'))).toBe('accepted');
          expect((await collection.close(context, id('1'))).choice).toBe('done');
        }
      }
    }
    await expect(collector(true, []).publish(publication('1'))).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/providerAttemptId' });
  });
  it('rejects every mismatched work/context field and fencing epoch', async () => {
    const changedContexts = [
      { ...context, work: { ...context.work, activationId: id<'activation'>('other') } },
      { ...context, work: { ...context.work, flowInvocationId: id<'flowInvocation'>('other') } },
      { ...context, work: { ...context.work, step: ['other'] as const } },
      { ...context, owner: { ...context.owner, ownerEpoch: id<'ownerEpoch'>('4') } },
      { ...context, permissionsJson: json('["write"]') }, { ...context, scopeJson: json('{"changed":true}') },
      { ...context, registryVersion: 'other' },
    ];
    for (const changed of changedContexts) await expect(collector(false).append({ ...message(), context: changed })).rejects.toThrow('attributed');
  });
  it('requires contiguous canonical sequences and a cursor covering every accepted event', async () => {
    const collection = collector(false);
    await collection.append(message('2'));
    for (const cursor of ['0', '1', '2', '02']) await expect(collection.close(context, id(cursor))).rejects.toThrow();
    for (const sequence of ['0', '01', '-1', '1e0']) await expect(collector(false).append(message(sequence))).rejects.toThrow();
    await expect(collector(false).append(message('01'))).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/sequence' });
  });
  it('rejects non-string Message sequences before signing and leaves the position unused', async () => {
    const omitted = { ...message() };
    delete (omitted as { sequence?: Sequence }).sequence;
    const malformed = [omitted, ...[0, 1, 1n, undefined, Object('1'), '0'].map(sequence => ({ ...message(), sequence }))];
    for (const event of malformed) {
      const collection = collector(false);
      await expect(collection.append(event as VisibleResponseMessage)).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/sequence' });
      expect(await collection.append(message())).toBe('accepted');
      expect((await collection.close(context, id('1'))).text).toBe('visible');
    }
  });
  it('rejects non-string publication sequences before signing and leaves the position unused', async () => {
    const omitted = { ...publication('1') };
    delete (omitted as { sequence?: Sequence }).sequence;
    const malformed = [omitted, ...[0, 1, 1n, undefined, Object('1'), '0'].map(sequence => ({ ...publication('1'), sequence }))];
    for (const event of malformed) {
      const collection = collector();
      await expect(collection.publish(event as TypedPublication)).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/sequence' });
      expect(await collection.publish(publication('1'))).toBe('accepted');
      expect((await collection.close(context, id('1'))).choice).toBe('done');
    }
  });
  it('rejects non-string cursors without closing or consuming later valid emissions', async () => {
    for (const cursor of [0, 0n, undefined, Object('0')]) {
      const collection = collector(false);
      await expect(collection.close(context, cursor as Sequence)).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/cursor' });
      expect(await collection.append(message())).toBe('accepted');
      expect((await collection.close(context, id('1'))).cursor).toBe(id('1'));
    }
    const closed = collector(false);
    await closed.close(context, id('0'));
    await expect(closed.close(context, 0 as unknown as Sequence)).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/cursor' });
  });
  it('requires primitive canonical epochs at capture and on every attribution envelope', async () => {
    const omitted = { ...context, owner: { ...context.owner } };
    delete (omitted.owner as { ownerEpoch?: unknown }).ownerEpoch;
    const malformed = [omitted, ...[3, 3n, undefined, Object('3'), '', '03', '-1'].map(ownerEpoch => ({ ...context, owner: { ...context.owner, ownerEpoch } }))];
    for (const supplied of malformed) {
      const invalidContext = supplied as ExecutionContext;
      await expect(Promise.resolve().then(() => collector(false, [id('attempt')], invalidContext))).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/ownerEpoch' });
      const collection = collector();
      await expect(collection.append({ ...message(), context: invalidContext })).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/ownerEpoch' });
      await expect(collection.publish({ ...publication('1'), context: invalidContext })).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/ownerEpoch' });
      await expect(collection.close(invalidContext, id('0'))).rejects.toMatchObject({ code: 'CORRELATION', pointer: '/ownerEpoch' });
      expect(await collection.publish(publication('1'))).toBe('accepted');
      expect((await collection.close(context, id('1'))).choice).toBe('done');
    }
  });
  it('retains enormous canonical identifiers exactly while still rejecting actual sequence holes', async () => {
    const enormous = '90071992547409931234567890123456789012345678901234567890';
    const capturedContext = { ...context, owner: { ...context.owner, ownerEpoch: id<'ownerEpoch'>(enormous) } };
    const collection = collector(false, [id('attempt')], capturedContext);
    await collection.append({ ...message(), context: capturedContext });
    expect((await collection.close(capturedContext, id('1'))).text).toBe('visible');
    const hole = collector(false);
    expect(await hole.append(message(enormous))).toBe('accepted');
    expect(await hole.append(message(enormous))).toBe('duplicate');
    await expect(hole.close(context, id(enormous))).rejects.toThrow('Emission cursor contains a hole');
  });
  it('closes once, retains its result and rejects all late emissions', async () => {
    const collection = collector(false);
    await collection.append(message());
    const closed = await collection.close(context, id('1'));
    expect(await collection.close(context, id('1'))).toEqual(closed);
    await expect(collection.append(message())).rejects.toThrow('closed');
    await expect(collection.append(message('2', 'late'))).rejects.toThrow('closed');
    await expect(collection.close(context, id('2'))).rejects.toThrow('cursor');
    expect((await collector(false).close(context, id('0'))).text).toBe('');
  });
  it('never derives required outputs or a choice from visible prose', async () => {
    const collection = collector();
    await collection.append(message('1', 'm1', ['done {"report":9007199254740993}']));
    await expect(collection.close(context, id('1'))).rejects.toThrow('Required output');
  });
  it('accepts only the registered protocol with declared exact results and final choice', async () => {
    const collection = collector();
    await collection.append(message());
    expect(await collection.publish(publication())).toBe('accepted');
    expect(await collection.publish(publication())).toBe('duplicate');
    const result = await collection.close(context, id('2'));
    expect(result.choice).toBe('done');
    expect(result.resultsJson).toContain('9007199254740993.0');
    expect(result.text).toBe('visible');
    await expect(collection.publish(publication())).rejects.toThrow('closed');
  });
  it('rejects forged protocols, undeclared results, rounded values and ambiguous publications', async () => {
    const invalid = [
      publication('1', { contractJson: json('{}') }), publication('1', { choice: 'unknown' }),
      publication('1', { resultsJson: json('{"report":{"value":9007199254740992,"mediaType":"application/json"}}') }),
      publication('1', { resultsJson: json('{"other":{"value":1,"mediaType":"application/json"}}') }),
      publication('1', { resultsJson: json('{"report":{"uri":"file:///report","mediaType":"application/json"}}') }),
    ];
    for (const event of invalid) await expect(collector().publish(event)).rejects.toThrow();
    const collection = collector(); await collection.publish(publication('1'));
    await expect(collection.publish(publication('2', { publicationId: 'other' }))).rejects.toThrow('ambiguous');
    await expect(collector(false).publish(publication('1'))).rejects.toThrow('explicit');
  });
  it('owns input copies so caller mutations cannot replace captured text or declarations', async () => {
    const collection = collector(false), event = message();
    await collection.append(event); (event.textParts as string[])[0] = 'mutated';
    expect((await collection.close(context, id('1'))).text).toBe('visible');
  });
  it('collects graphless Agent work under an explicit contract without creating a task or graph', async () => {
    const graphlessContext = { ...context, work: { ...context.work, step: null } };
    const contract = json('{"protocol":"macro-agsdl-publication/1","registryVersion":"synthetic-captured/1","agent":"worker","step":null,"interface":{},"choices":[],"decisionBinding":null}');
    const collection = new ExactResponseCollection({ context: graphlessContext, providerAttempts: [id('attempt')], interfaceJson: json('{}'), stepJson: null, agentName: 'worker', publicationContractJson: contract });
    await collection.append({ ...message(), context: graphlessContext });
    expect((await collection.close(graphlessContext, id('1'))).text).toBe('visible');
  });
  it('bounds attributed events and text without truncating required content', async () => {
    const collection = new ExactResponseCollection({ context, providerAttempts: [id('attempt')], interfaceJson: json('{}'), stepJson: json('{"type":"agent","agent":"worker"}'), publicationContractJson: null, limits: { maxEvents: 1, maxTextBytes: 2 } });
    await expect(collection.append(message('1', 'm1', ['long']))).rejects.toThrow('text bound');
    await collection.append(message('1', 'm1', ['ok']));
    await expect(collection.append(message('2', 'm2', ['']))).rejects.toThrow('event bound');
  });
});
