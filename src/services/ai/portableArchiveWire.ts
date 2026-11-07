import type { PortableDescriptor, PortableHeader } from '../../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';

export function portableDescriptor(result: { records: number; bytes: number; manifest: string }, contractSha: string): PortableDescriptor {
  return { kind: 'portable_archive', format: 'portable-chat-history-1', content_contract_sha256: contractSha,
    records: result.records, bytes: result.bytes, manifest_sha256: result.manifest };
}
/** One canonical E fragment, never a serialized transcript. */
export function portableFragment(header: PortableHeader, offset: number, bytes: Uint8Array): string {
  return JSON.stringify({ header, offset, data: Buffer.from(bytes).toString('base64') }) + '\n';
}
