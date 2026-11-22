import { describe,expect,it } from 'bun:test';
import { NumberToken as ReaderNumberToken,parse } from '../../vendor/agsdl/v0.4/reader.mjs';
import { NumberToken,clone,decimal,decode,encode,equal,record } from './exact';
import { sourceDigest } from './sourceDigest';

describe('shared exact values', () => {
  it('uses one number identity across the reader and execution boundary', () => {
    expect(NumberToken).toBe(ReaderNumberToken);
    const raw = '{"large":9007199254740993,"exponent":1e999999,"negativeZero":-0,"text":"é\\n𝄞"}';
    const value = record(decode(raw));
    expect(value.large).toBeInstanceOf(ReaderNumberToken);
    expect(String(encode(value))).toBe(raw);
    expect(String(encode(clone(value)))).toBe(raw);
    const parsed = parse(new TextEncoder().encode(raw));
    expect(parsed.error).toBeUndefined();
    expect(equal(value, parsed.tree)).toBe(true);
    expect(decimal(new NumberToken('1200e-2'))).toEqual(['', '12', 0n]);
    expect(decimal(new NumberToken('-0.00e999999'))).toEqual(['', '0', 0n]);
    expect(equal(new NumberToken('9007199254740993'), new NumberToken('9007199254740992'))).toBe(false);
  });

  it('keeps exact JSON rejection and byte diagnostics', () => {
    for (const raw of ['{"a":1,"a":2}', '"\\uD800"', '[01]', '1e', '"\uD800"']) {
      expect(() => decode(raw)).toThrow('Invalid or unsupported exact JSON.');
    }
    const parsed = parse(new TextEncoder().encode('{"é":0,"é":1}'));
    expect(parsed.error?.byte).toBe(8);
  });

  it('hashes UTF-8 source bytes independently of the compiler', async () => {
    expect(await sourceDigest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
