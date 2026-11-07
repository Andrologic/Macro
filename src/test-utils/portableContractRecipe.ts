/** Explicit synthetic recipe only: canonically framed content, no public route.
 * The receiving spool is private staging, removed on every late refusal. */
import { open, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { portableLines, validatePortableArchive } from '../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
import contractRoot from '../../contracts/macro-pilot/v2/portable-chat-history/portable-chat-history-contract.json';
import { inspectPortableRecordContent, portableDigest } from '../services/ai/portableChatHistory';
import type { PortableWorkBudget } from '../services/ai/portableHistoryInspection';
import type { TextPolicy } from '../services/macroPilot/conversationText';

let contractIdentity: Promise<string> | undefined;
export function portableContractSha(): Promise<string> {
  return contractIdentity ??= portableDigest(new TextEncoder().encode(JSON.stringify(contractRoot, null, 2) + '\n'));
}
export async function validatePortableRecipe(path: string, destination: string, budget: PortableWorkBudget, policy: TextPolicy) {
  const release = budget.reserve(8192 * 8);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let stream: ReturnType<typeof createReadStream> | undefined;
  const allowance = 128 * 1024 * 1024; // Synthetic per-spool disk, not a product quota.
  let spoolBytes = 0, fragments = 0, records = 0;
  try {
    output = await open(destination, 'wx', 0o600);
    stream = createReadStream(path, { highWaterMark: 8192 });
    const result = await validatePortableArchive(portableLines(stream), await portableContractSha(), {
      reserve: bytes => budget.reserve(bytes), digest: portableDigest,
      inspect: async (header, bytes, origin, metadata) => {
        if (metadata && metadata.policy !== policy.revision) throw new Error('policy_changed');
        inspectPortableRecordContent(header, bytes, origin, policy);
      },
      append: async (header, bytes) => {
        records++;
        const write = async (offset: number, fragment: Uint8Array) => {
          const line = JSON.stringify({ header, offset, data: Buffer.from(fragment).toString('base64') }) + '\n';
          const length = Buffer.byteLength(line);
          if (spoolBytes + length > allowance) throw new Error('proof_file_allowance');
          await output!.write(line); spoolBytes += length; fragments++;
        };
        if (!bytes.length) await write(0, bytes);
        for (let offset = 0; offset < bytes.length; offset += 4093) await write(offset, bytes.subarray(offset, offset + 4093));
      },
    });
    if (records !== result.records) throw new Error('fixture_count_mismatch');
    return { ...result, nativeAppendFragments: fragments, normalizedSpoolBytes: spoolBytes, normalizedFragments: fragments };
  } catch (error) {
    if (output) { await output.close(); await unlink(destination); }
    throw error;
  } finally { stream?.destroy(); await output?.close(); release(); }
}
export { portableDescriptor, portableFragment } from '../services/ai/portableArchiveWire';
