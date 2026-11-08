/** Synchronous adapter for messages030. The native host captures every URI first. */
import type { ExactJsonText } from './contracts';
import { decode, encode, equal, fail, has, record } from './exact';

export type ContentPayload030 =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'json'; readonly json: string }
  | { readonly kind: 'media'; readonly base64: string };

export interface CapturedContentReceipt030 {
  readonly sourceJson: ExactJsonText;
  readonly payload: ContentPayload030;
  readonly provenance: {
    readonly captureId: string;
    readonly sourceDigest: string;
    readonly agent: string;
    readonly usage: 'prompt' | 'resource';
    readonly pointer: string;
    readonly requestedUri: string | null;
    readonly mediaType: string;
    readonly sha256: string;
    readonly policyDigest: string;
  };
}

export interface ContentCaptureIdentity030 {
  readonly captureId: string;
  readonly sourceDigest: string;
  readonly agent: string;
  readonly policyDigest: string;
}

/** The host owns the receipt list; never build it from a message or model output. */
export function capturedContent030(identity: ContentCaptureIdentity030, receipts: readonly CapturedContentReceipt030[]) {
  return {
    resolveSource(sourceJson: ExactJsonText, use: { readonly usage: 'prompt' | 'resource'; readonly pointer: string }): ExactJsonText {
      const source = record(decode(sourceJson));
      if (has(source, 'value')) return encode(source);
      if (!has(source, 'uri') || typeof source.uri !== 'string') return fail('CONTENT_UNAVAILABLE', use.pointer, 'Expected an inline value or captured URI.');
      const matches = receipts.filter(receipt =>
        equal(decode(receipt.sourceJson), source) && receipt.provenance.pointer === use.pointer && receipt.provenance.usage === use.usage &&
        receipt.provenance.captureId === identity.captureId && receipt.provenance.sourceDigest === identity.sourceDigest &&
        receipt.provenance.agent === identity.agent && receipt.provenance.policyDigest === identity.policyDigest &&
        receipt.provenance.requestedUri === source.uri && /^[a-f0-9]{64}$/.test(receipt.provenance.sha256));
      if (matches.length !== 1) return fail('CONTENT_UNAVAILABLE', use.pointer, 'No uniquely correlated native content receipt.');
      const { payload, provenance } = matches[0];
      const value = payload.kind === 'json' ? encode(decode(payload.json)) : JSON.stringify(payload.kind === 'text' ? payload.text : payload.base64);
      return `{"value":${value},"mediaType":${JSON.stringify(provenance.mediaType)}}` as ExactJsonText;
    },
  };
}
