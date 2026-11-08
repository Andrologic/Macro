import { describe, expect, it } from 'bun:test';
import type { ExactJsonText } from './contracts';
import { capturedContent030, type CapturedContentReceipt030 } from './contentResolution030';

const json = (value: string) => value as ExactJsonText;
const identity = { captureId: 'capture', sourceDigest: 'source', agent: 'worker', policyDigest: 'policy' };
const sourceJson = json('{"uri":"data.json","mediaType":"application/json"}');
const receipt: CapturedContentReceipt030 = {
  sourceJson, payload: { kind: 'json', json: '{"n":9007199254740993}' },
  provenance: { ...identity, usage: 'prompt', pointer: '/prompt/0', requestedUri: 'data.json', mediaType: 'application/json', sha256: 'a'.repeat(64) },
};

describe('captured content adapter', () => {
  it('preserves exact numbers and checks the captured source, use and identity', () => {
    const content = capturedContent030(identity, [receipt]);
    expect(content.resolveSource(sourceJson, { usage: 'prompt', pointer: '/prompt/0' })).toBe(json('{"value":{"n":9007199254740993},"mediaType":"application/json"}'));
    expect(() => content.resolveSource(sourceJson, { usage: 'resource', pointer: '/prompt/0' })).toThrow('receipt');
    expect(() => capturedContent030({ ...identity, agent: 'other' }, [receipt]).resolveSource(sourceJson, { usage: 'prompt', pointer: '/prompt/0' })).toThrow('receipt');
    expect(() => capturedContent030(identity, [receipt, receipt]).resolveSource(sourceJson, { usage: 'prompt', pointer: '/prompt/0' })).toThrow('receipt');
  });
  it('does not interpret references inside a literal value', () => {
    const source = json('{"value":{"uri":"file:///secret","ref":"x"}}');
    expect(capturedContent030(identity, []).resolveSource(source, { usage: 'resource', pointer: '/r' })).toBe(source);
  });
  it('retains a captured media payload and rejects a substituted source', () => {
    const mediaSource = json('{"uri":"image.png","mediaType":"image/png"}');
    const media: CapturedContentReceipt030 = {
      sourceJson: mediaSource, payload: { kind: 'media', base64: 'AAEC/w==' },
      provenance: { ...identity, usage: 'resource', pointer: '/r', requestedUri: 'image.png', mediaType: 'image/png', sha256: 'b'.repeat(64) },
    };
    const content = capturedContent030(identity, [media]);
    expect(content.resolveSource(mediaSource, { usage: 'resource', pointer: '/r' })).toBe(json('{"value":"AAEC/w==","mediaType":"image/png"}'));
    expect(() => content.resolveSource(json('{"uri":"other.png","mediaType":"image/png"}'), { usage: 'resource', pointer: '/r' })).toThrow('receipt');
  });
  it('matches an expanded source despite whitespace, field order and JSON escaping', () => {
    const escaped = json('{ "mediaType" : "application/json", "uri" : "data\\u002ejson" }');
    const content = capturedContent030(identity, [{ ...receipt, sourceJson: escaped }]);
    expect(content.resolveSource(sourceJson, { usage: 'prompt', pointer: '/prompt/0' })).toBe(json('{"value":{"n":9007199254740993},"mediaType":"application/json"}'));
  });
  it('rejects isolated surrogates in the source before UTF-8 encoding', () => {
    for (const unit of [0xd800, 0xdc00]) {
      const invalid = json(`{"value":"${String.fromCharCode(unit)}"}`);
      expect(() => capturedContent030(identity, []).resolveSource(invalid, { usage: 'resource', pointer: '/r' })).toThrow('exact JSON');
    }
  });
});
