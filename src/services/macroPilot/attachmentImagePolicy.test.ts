import { describe, expect, test } from 'bun:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { inspectAttachmentImage, type AttachmentImageVerdict } from './attachmentImagePolicy';

const text = (value: string) => Buffer.from(value, 'latin1');
const cat = (...values: Uint8Array[]) => Buffer.concat(values);
const be16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
const be32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const le32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(kind: string, data = Buffer.alloc(0)): Buffer {
  const value = cat(text(kind), data);
  return cat(be32(data.length), value, be32(crc32(value)));
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = cat(be32(1), be32(1), Buffer.from([8, 0, 0, 0, 0]));
const idat = pngChunk('IDAT', deflateSync(Buffer.from([0, 127])));
function png(metadata: Buffer[] = [], header = ihdr): Buffer {
  return cat(pngSignature, pngChunk('IHDR', header), ...metadata, idat, pngChunk('IEND'));
}
function segment(marker: number, data: Buffer): Buffer { return cat(Buffer.from([255, marker]), be16(data.length + 2), data); }
const quantization = segment(0xdb, cat(Buffer.from([0]), Buffer.alloc(64, 1)));
// One-bit DC zero and AC end-of-block codes encode a readable gray 1x1 image.
const huffman = segment(0xc4, cat(Buffer.from([0, 1]), Buffer.alloc(15), Buffer.from([0, 0x10, 1]), Buffer.alloc(15), Buffer.from([0])));
const frame = (progressive = false) => segment(progressive ? 0xc2 : 0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
const scan = (progressive = false) => cat(segment(0xda, Buffer.from([1, 1, 0, 0, progressive ? 0 : 63, 0])), Buffer.from([progressive ? 0x7f : 0x3f]));
const jfif = segment(0xe0, cat(text('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])));
function jpeg(metadata: Buffer[] = []): Buffer {
  return cat(Buffer.from([255, 216]), jfif, ...metadata, quantization, frame(), huffman, scan(), Buffer.from([255, 217]));
}
function gifBlocks(data: Buffer): Buffer {
  const blocks: Buffer[] = [];
  for (let p = 0; p < data.length; p += 255) blocks.push(Buffer.from([Math.min(255, data.length - p)]), data.subarray(p, p + 255));
  return cat(...blocks, Buffer.from([0]));
}
const gifHeader = cat(text('GIF89a'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255]));
const gifImage = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0]);
function gif(metadata: Buffer[] = [], animated = false): Buffer {
  return cat(gifHeader, ...metadata, gifImage, ...(animated ? [gifImage] : []), Buffer.from([0x3b]));
}
const loop = cat(Buffer.from([0x21, 0xff, 11]), text('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]));
function webpChunk(kind: string, data: Buffer): Buffer {
  return cat(text(kind), le32(data.length), data, sizePad(data.length));
}
function sizePad(size: number): Buffer { return Buffer.alloc(size & 1); }
function webp(chunks: Buffer[]): Buffer { const data = cat(text('WEBP'), ...chunks); return cat(text('RIFF'), le32(data.length), data); }
// Synthetic one-pixel lossless bitstream, no ICC, Exif or XMP.
const webpPixel = Buffer.from('2f00000010071011118888fe0700', 'hex');
const vp8l = webpChunk('VP8L', webpPixel);
const vp8x = (flags = 0) => webpChunk('VP8X', Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
const ordinary: [string, Buffer][] = [
  ['image/png', png()], ['image/jpeg', jpeg()], ['image/gif', gif()], ['image/webp', webp([vp8l])],
];
const sensitive = 'synthetic-image-credential\n/home/synthetic/private-image.txt\nC:\\synthetic\\private.txt';
const zipped = deflateSync(text(sensitive));
const expectVerdict = (mime: string, bytes: Buffer, verdict: AttachmentImageVerdict) => expect(inspectAttachmentImage(bytes, mime)).toBe(verdict);

describe('attachment image metadata policy', () => {
  test.each(ordinary)('permits ordinary synthetic pixels in %s without changing bytes', (mime, bytes) => {
    const before = Buffer.from(bytes); expectVerdict(mime, bytes, 'available'); expect(bytes).toEqual(before);
    // Nonzero byteOffset must not accidentally inspect surrounding allocation.
    const surrounded = cat(text(sensitive), bytes, zipped);
    expect(inspectAttachmentImage(surrounded.subarray(text(sensitive).length, text(sensitive).length + bytes.length), mime)).toBe('available');
  });
  test('permits PNG fixed structures and contiguous plain text after host inspection', () => {
    expectVerdict('image/png', png([
      pngChunk('gAMA', be32(45455)), pngChunk('cHRM', Buffer.alloc(32)), pngChunk('sRGB', Buffer.from([0])),
      pngChunk('pHYs', cat(be32(1000), be32(1000), Buffer.from([1]))), pngChunk('sBIT', Buffer.from([8])),
      pngChunk('bKGD', Buffer.from([0, 0])), pngChunk('tRNS', Buffer.from([0, 0])),
      pngChunk('tIME', Buffer.from([7, 234, 10, 12, 12, 0, 0])), pngChunk('tEXt', text('Comment\0Bonjour')),
    ]), 'available');
  });
  test('permits palette PNG, raw JFIF thumbnail and fixed Adobe record', () => {
    const paletteHeader = Buffer.from(ihdr); paletteHeader[9] = 3;
    expectVerdict('image/png', png([pngChunk('PLTE', Buffer.from([127, 127, 127])), pngChunk('tRNS', Buffer.from([255]))], paletteHeader), 'available');
    const thumbnail = segment(0xe0, cat(text('JFIF\0'), Buffer.from([1, 2, 0, 0, 1, 0, 1, 1, 1, 127, 127, 127])));
    expectVerdict('image/jpeg', jpeg([thumbnail, segment(0xee, cat(text('Adobe'), Buffer.from([0, 100, 0, 0, 0, 0, 1]))), segment(0xfe, text('Bonjour'))]), 'available');
  });
  test('permits GIF animation with the exact fixed loop and graphics control records', () => {
    expectVerdict('image/gif', gif([loop, Buffer.from([0x21, 0xf9, 4, 0, 1, 0, 0, 0])], true), 'available');
  });
  test('permits WebP extended lossless, alpha and animation pixel containers', () => {
    expectVerdict('image/webp', webp([vp8x(), vp8l]), 'available');
    const lossy = webpChunk('VP8 ', Buffer.from('3001009d012a010001000ec0fe25a400037000000000', 'hex'));
    expectVerdict('image/webp', webp([vp8x(0x10), webpChunk('ALPH', Buffer.from([0, 255])), lossy]), 'available');
    expectVerdict('image/webp', webp([vp8x(2), webpChunk('ANIM', Buffer.alloc(6)), webpChunk('ANMF', cat(Buffer.alloc(16), vp8l))]), 'available');
  });
  test('reproduces the compressed PNG regression after 64 KiB and withholds it', () => {
    expect(inflateSync(zipped).toString('latin1')).toBe(sensitive);
    const bytes = png([pngChunk('tEXt', cat(text('Padding\0'), Buffer.alloc(66000, 97))), pngChunk('zTXt', cat(text('Comment\0\0'), zipped))]);
    expect(bytes.indexOf(zipped)).toBeGreaterThan(65536);
    expect(bytes.includes(text(sensitive))).toBe(false);
    expectVerdict('image/png', bytes, 'withheld');
    console.log(JSON.stringify({ regression: 'late-zTXt', offset: bytes.indexOf(zipped), bytes: bytes.length, previous: 'available per independent audit', corrected: inspectAttachmentImage(bytes, 'image/png') }));
  });
  test.each(['zTXt', 'iTXt', 'iCCP', 'eXIf'])('withholds opaque PNG %s metadata containing compressed secret/path', kind => {
    const prefix = kind === 'iTXt' ? text('Metadata\0\x01\0\0\0') : text('Metadata\0\0');
    expectVerdict('image/png', png([pngChunk(kind, cat(prefix, zipped))]), 'withheld');
  });
  test('withholds uncompressed iTXt, unknown PNG metadata and binary tEXt', () => {
    expectVerdict('image/png', png([pngChunk('iTXt', text('Comment\0\0\0\0\0Bonjour'))]), 'withheld');
    expectVerdict('image/png', png([pngChunk('aaAA', zipped)]), 'withheld');
    expectVerdict('image/png', png([pngChunk('tEXt', cat(text('Comment\0'), zipped))]), 'withheld');
  });
  test.each([0xe1, 0xe2, 0xe3, 0xed, 0xef])('withholds opaque JPEG APP marker %i with compressed secret/path', marker => {
    const prefix = marker === 0xe1 ? 'Exif\0\0' : marker === 0xe2 ? 'ICC_PROFILE\0' : 'Opaque\0';
    expectVerdict('image/jpeg', jpeg([segment(marker, cat(text(prefix), zipped))]), 'withheld');
  });
  test('withholds JPEG metadata between progressive scans and binary comments', () => {
    const progressive = cat(Buffer.from([255, 216]), quantization, frame(true), huffman, scan(true),
      segment(0xe2, cat(text('ICC_PROFILE\0'), zipped)), segment(0xda, Buffer.from([1, 1, 0, 1, 63, 0])), Buffer.from([0x7f, 255, 217]));
    expectVerdict('image/jpeg', progressive, 'withheld');
    expectVerdict('image/jpeg', jpeg([segment(0xfe, zipped)]), 'withheld');
    expectVerdict('image/jpeg', jpeg([segment(0xe0, cat(text('JFXX\0'), zipped))]), 'withheld');
  });
  test.each(['SYNTHETIC01', 'NETSCAPE2.0', 'ICCRGBG1012'])('withholds GIF application %s containing compressed secret/path', app => {
    expectVerdict('image/gif', gif([cat(Buffer.from([0x21, 0xff, 11]), text(app), gifBlocks(zipped))]), 'withheld');
  });
  test('withholds GIF split comments, plain text and surplus loop blocks', () => {
    const split = cat(Buffer.from([0x21, 0xfe, 10]), text(sensitive.slice(0, 10)), gifBlocks(text(sensitive.slice(10))));
    expectVerdict('image/gif', gif([split]), 'withheld');
    expectVerdict('image/gif', gif([cat(Buffer.from([0x21, 1, 12]), Buffer.alloc(12), gifBlocks(zipped))]), 'withheld');
    const surplusLoop = cat(loop.subarray(0, loop.length - 1), gifBlocks(zipped));
    expectVerdict('image/gif', gif([surplusLoop]), 'withheld');
  });
  test.each(['ICCP', 'EXIF', 'XMP ', 'zzzz'])('withholds WebP %s with compressed secret/path', kind => {
    expectVerdict('image/webp', webp([vp8x(), vp8l, webpChunk(kind, zipped)]), 'withheld');
  });
  test('withholds metadata advertised by WebP flags or nested inside animation', () => {
    expectVerdict('image/webp', webp([vp8x(0x2c), vp8l]), 'withheld');
    expectVerdict('image/webp', webp([vp8x(2), webpChunk('ANIM', Buffer.alloc(6)),
      webpChunk('ANMF', cat(Buffer.alloc(16), vp8l, webpChunk('EXIF', zipped)))]), 'withheld');
  });
  test('withholds opaque UTF-16 paths and benign compressed metadata independently of secret matching', () => {
    for (const payload of [Buffer.from('/home/synthetic/private.txt', 'utf16le'), deflateSync(text('Benign metadata'))]) {
      expectVerdict('image/png', png([pngChunk('eXIf', payload)]), 'withheld');
      expectVerdict('image/jpeg', jpeg([segment(0xe1, cat(text('Exif\0\0'), payload))]), 'withheld');
      expectVerdict('image/gif', gif([cat(Buffer.from([0x21, 0xff, 11]), text('SYNTHETIC01'), gifBlocks(payload))]), 'withheld');
      expectVerdict('image/webp', webp([vp8l, webpChunk('EXIF', payload)]), 'withheld');
    }
  });
  test('refuses empty pixel containers rather than accepting their signatures', () => {
    expectVerdict('image/png', cat(pngSignature, pngChunk('IHDR', ihdr), pngChunk('IDAT'), pngChunk('IEND')), 'unsupported');
    expectVerdict('image/webp', webp([webpChunk('VP8L', webpPixel.subarray(0, 5))]), 'unsupported');
    expectVerdict('image/webp', webp([webpChunk('VP8 ', Buffer.from([0x10, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0]))]), 'unsupported');
  });
  test.each(ordinary)('refuses every truncated prefix and trailing payload in %s', (mime, bytes) => {
    for (let n = 0; n < bytes.length; n++) expectVerdict(mime, bytes.subarray(0, n), 'unsupported');
    expectVerdict(mime, cat(bytes, zipped), 'unsupported');
  });
  test('refuses MIME mismatch and unsupported format', () => {
    for (const [mime, bytes] of ordinary) {
      for (const [other] of ordinary) if (mime !== other) expectVerdict(other, bytes, 'unsupported');
      expectVerdict('application/octet-stream', bytes, 'unsupported');
    }
    expectVerdict('image/avif', ordinary[0][1], 'unsupported');
  });
  test('refuses bad CRC, oversized lengths, structural surplus and missing image payload', () => {
    const badCrc = png(); badCrc[29] ^= 1; expectVerdict('image/png', badCrc, 'unsupported');
    expectVerdict('image/png', cat(pngSignature, be32(0xffffffff), text('IHDR')), 'unsupported');
    expectVerdict('image/png', png([pngChunk('gAMA', cat(be32(45455), zipped))]), 'unsupported');
    expectVerdict('image/jpeg', cat(Buffer.from([255, 216]), segment(0xe0, cat(text('JFIF\0'), Buffer.alloc(9), zipped))), 'unsupported');
    expectVerdict('image/jpeg', Buffer.from([255, 216, 255, 224, 255, 255, 255, 217]), 'unsupported');
    expectVerdict('image/gif', cat(gifHeader, Buffer.from([0x21, 0xff, 255])), 'unsupported');
    expectVerdict('image/webp', webp([cat(text('EXIF'), le32(0xffffffff))]), 'unsupported');
    expectVerdict('image/webp', webp([vp8x(), webpChunk('ANIM', cat(Buffer.alloc(6), zipped))]), 'unsupported');
    expectVerdict('image/webp', webp([webpChunk('EXIF', zipped)]), 'unsupported');
  });
  test('uses no inflater even for tiny metadata claiming a huge expansion', () => {
    const bomb = deflateSync(Buffer.alloc(2 * 1024 * 1024, 97));
    expectVerdict('image/png', png([pngChunk('zTXt', cat(text('Comment\0\0'), bomb))]), 'withheld');
    expectVerdict('image/jpeg', jpeg([segment(0xe2, bomb)]), 'withheld');
    expectVerdict('image/gif', gif([cat(Buffer.from([0x21, 0xff, 11]), text('SYNTHETIC01'), gifBlocks(bomb))]), 'withheld');
    expectVerdict('image/webp', webp([vp8l, webpChunk('ICCP', bomb)]), 'withheld');
  });
});
