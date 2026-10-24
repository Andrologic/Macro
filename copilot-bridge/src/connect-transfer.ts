import { createHash } from 'node:crypto';
import { IDENTITIES } from '../../contracts/macro-pilot/v2/transfer-transit/identities.generated.mjs';
import { Frame, Reject, FrameReader, FrameWriter, CodecFailure, u32 } from './connect-codec-framing';
import { PortableWorkBudget, samePortablePolicy } from '../../src/services/ai/portableHistoryInspection';
import { normalizePortableChatHistoryTwoPass, inspectPortableRecordContent, portableDigest } from '../../src/services/ai/portableChatHistory';
import { PortableHistoryArchive } from '../../src/services/ai/portableHistoryArchive';
import { portableDescriptor } from '../../src/services/ai/portableArchiveWire';
import { portableLines, validatePortableArchive } from '../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
import { TransferClient, DATA_CREDIT } from './connect-transfer-client';
import { TransferPorts } from './connect-transfer-ports';
import { prepareReference } from './connect-transfer-preparation';
import { CONTROL_RESERVE, TransferFailure, ensure, integer, decimal, sum } from './connect-transfer-values';
import { decodeControl, encodeControl, validateHello, validateStart, validateGrant } from './connect-transfer-protocol';
import { TRANSFER_HELLO } from './connect-transfer-identities.generated';

const errorStatus = (error: unknown) => {
  if (error instanceof TransferFailure) return error.status;
  if (error instanceof CodecFailure) return 8;
  const message = error instanceof Error ? error.message : '';
  if (message === 'resource_limit') return 1;
  if (['policy_changed', 'unsafe_content'].includes(message)) return 3;
  if (message === 'preparation_requires_compaction') return 6;
  if (['required_external_context', 'required_asset_missing', 'unsupported_asset'].includes(message)) return 4;
  if (message === 'unknown_required_shape') return 8;
  return 2;
};
async function execute(ports: TransferPorts): Promise<void> {
  const { client, budget } = ports, { handles, kind } = client.start;
  await ports.detection();
  if (kind === 'normalize') {
    const source = await ports.source();
    const result = await normalizePortableChatHistoryTwoPass(source, ports.policy, budget, { append: (header, bytes) => ports.append(header, bytes) }, async first => {
      await client.simple({ op: 3, handle: handles.sink, stage: 'begin', descriptor: portableDescriptor(first, IDENTITIES.content_contract_sha256) });
    });
    await client.simple({ op: 7, handle: handles.sink, kind: 'normalized', result: {
      records: decimal(result.records), bytes: decimal(result.bytes), manifest: result.manifest, policy: result.policy } });
    return;
  }
  if (kind === 'import') {
    const root = await ports.root('staging'); ensure(root.kind === 'staging');
    const before = await ports.policy();
    let planned = false;
    const run = async (append: boolean) => {
      const release = budget.reserve(8192 * 8);
      try {
        const staged = async function* () {
          const digest = createHash('sha256');
          for await (const page of ports.read(handles.staging, { ordinal: 0, bytes: integer(root.bytes), sha256: root.sha256 }, 65_536)) { digest.update(page); yield page; }
          ensure(digest.digest('hex') === root.sha256, 2);
        };
        const result = await validatePortableArchive(portableLines(staged()), IDENTITIES.content_contract_sha256, {
          reserve: units => budget.reserve(units), digest: portableDigest,
          inspect: async (header, bytes, origin, metadata) => {
            const policy = await ports.policy(); ensure(samePortablePolicy(policy, before), 3);
            if (metadata) ensure(metadata.policy === policy.revision, 3);
            inspectPortableRecordContent(header, bytes, origin, policy);
          },
          append: async (header, bytes) => {
            if (append) await ports.append(header, bytes);
            else {
              if (!planned) { await client.simple({ op: 3, handle: handles.sink, stage: 'begin', descriptor: root.descriptor }); planned = true; }
              await client.simple({ op: 3, handle: handles.sink, stage: 'header', header });
            }
          },
        });
        ensure(result.records === root.descriptor.records && result.bytes === root.descriptor.bytes && result.manifest === root.descriptor.manifest_sha256, 2);
        ensure(samePortablePolicy(await ports.policy(), before), 3); return result;
      } finally { release(); }
    };
    const first = await run(false);
    const result = { records: decimal(first.records), fragments: decimal(first.fragments), bytes: decimal(first.bytes), manifest: first.manifest };
    // The parent must perform the real inactive-storage begin here or refuse.
    await client.simple({ op: 3, handle: handles.sink, stage: 'end', result });
    ensure(samePortablePolicy(await ports.policy(), before), 3);
    const second = await run(true); ensure(JSON.stringify(first) === JSON.stringify(second), 2);
    await client.simple({ op: 7, handle: handles.sink, kind: 'imported', result }); return;
  }
  const { port, root } = await ports.archive();
  const archive = new PortableHistoryArchive(port, ports.policy, budget);
  try {
    await archive.open();
    if (kind === 'prepare') {
      const target = await ports.root('target'); ensure(target.kind === 'target');
      await archive.withProjection(projection => prepareReference(ports, projection, target));
      await client.simple({ op: 7, handle: handles.draft, kind: 'prepared_ts', result: { draft_handle: handles.draft,
        archive_manifest: root.binding.manifest, storage_revision: root.storage_revision, mapping_sha256: root.mapping_sha256,
        target_handle: handles.target, reference: 'synthetic' } });
    } else {
      const selector = await ports.root('selector'); ensure(selector.kind === 'selector');
      const consume = async (bytes: Uint8Array, ordinal: number) => {
        // withRecord owns decoded/base64 work; outgoing encoding owns its separate copy.
        const sha256 = await portableDigest(bytes);
        await ports.collection(handles.sink, 'archive-retrieval', [{ ordinal, sha256, base64: Buffer.from(bytes).toString('base64') }]);
        await ports.policy();
        await client.simple({ op: 7, handle: handles.sink, kind: 'recovered', result: { ordinal: decimal(ordinal), bytes: decimal(bytes.length), sha256 } });
      };
      const ordinal = integer(selector.ordinal);
      if (selector.uuid === null) await archive.withRecord(ordinal, bytes => consume(bytes, ordinal));
      else await archive.withUuid(selector.uuid, (bytes, actual) => { ensure(actual === ordinal, 2); return consume(bytes, actual); });
    }
  } finally { archive.dispose(); }
}

/** One heavy child per native work, exits after retirement. No resident idle E child. */
export async function runTransfer(input = 0, output = 1): Promise<void> {
  const reader = new FrameReader(input), writer = new FrameWriter(output);
  let job = 0n, arena = 0n, ports: TransferPorts | undefined, budget: PortableWorkBudget | undefined, detectionBudget: PortableWorkBudget | undefined, releaseProtocol: (() => void) | undefined;
  let status = 0, fatal = false, rejectCode: number = Reject.state;
  try {
    validateHello(TRANSFER_HELLO);
    await writer.send(Frame.HELLO, 0n, 0n, 0, encodeControl(TRANSFER_HELLO));
    const first = await reader.next(h => {
      if (h.type === Frame.STOP) { ensure(h.job === 0n && h.lease === 0n && h.sequence === 0 && h.length === 0); return; }
      ensure(h.type === Frame.BEGIN && h.job > 0n && h.lease === 0n && h.sequence === 0 && h.length <= 4096);
    });
    if (first.header.type === Frame.STOP) { await writer.send(Frame.STOPPED, 0n, 0n); return; }
    job = first.header.job;
    const start = decodeControl(first.payload); validateStart(start);
    const granted = await reader.next(h => ensure(h.type === Frame.GRANT && h.job === job && h.lease > 0n && h.sequence === 0 && h.length === 32));
    const grant = validateGrant(granted.payload); arena = granted.header.lease;
    ensure(grant.kind === 3 && grant.arena === arena && grant.units === sum(integer(start.child_units), integer(start.detection_units)), 8, Reject.credit);
    ensure(integer(start.native_units) >= CONTROL_RESERVE + DATA_CREDIT, 1);
    budget = new PortableWorkBudget(integer(start.child_units));
    detectionBudget = new PortableWorkBudget(integer(start.detection_units));
    releaseProtocol = budget.reserve(CONTROL_RESERVE + DATA_CREDIT);
    const client = new TransferClient(reader, writer, job, arena, start, budget, detectionBudget);
    ports = new TransferPorts(client);
    await execute(ports);
  } catch (error) {
    status = errorStatus(error); fatal = error instanceof CodecFailure || error instanceof TransferFailure && error.fatal;
    rejectCode = error instanceof CodecFailure ? error.code : error instanceof TransferFailure && error.fatal ? error.rejectCode : status === 1 ? Reject.limit : Reject.state;
  }
  finally { ports?.dispose(); releaseProtocol?.(); }
  if (budget && (budget.used !== 0 || detectionBudget!.used !== 0)) { status = 8; fatal = true; rejectCode = Reject.credit; }
  if (job && arena && budget && !fatal) await writer.send(Frame.JOB_FINISHED, job, arena, 0, u32(status === 0 ? 0 : status === 7 ? 2 : 1));
  else { await writer.send(Frame.REJECT, job, 0n, 0, u32(rejectCode)); process.exitCode = 1; }
}
