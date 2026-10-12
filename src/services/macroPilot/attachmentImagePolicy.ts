/** Metadata gate for attachment exports, after the host's full UTF-8 and Latin-1
 * policy inspection. `available` means the container uses recognized pixel data,
 * decoding structures and inspectable plain text. It is not a pixel decoder or
 * a defence against steganography. Unknown/opaque metadata is withheld intact.
 * No decompression, I/O, imports, mutation or size-dependent allocation occurs.
 * The host retains its file-size limit and must inspect these same bytes.
 */
export type AttachmentImageVerdict = 'available' | 'withheld' | 'unsupported';

const ascii = (b: Uint8Array, p: number, text: string): boolean =>
  p + text.length <= b.length && [...text].every((c, i) => b[p + i] === c.charCodeAt(0));
const u16be = (b: Uint8Array, p: number): number => b[p] * 256 + b[p + 1];
const u16le = (b: Uint8Array, p: number): number => b[p] + b[p + 1] * 256;
const u32be = (b: Uint8Array, p: number): number => b[p] * 0x1000000 + b[p + 1] * 65536 + b[p + 2] * 256 + b[p + 3];
const u32le = (b: Uint8Array, p: number): number => b[p] + b[p + 1] * 256 + b[p + 2] * 65536 + b[p + 3] * 0x1000000;
const u24le = (b: Uint8Array, p: number): number => b[p] + b[p + 1] * 256 + b[p + 2] * 65536;
const plainText = (b: Uint8Array, start: number, end: number): boolean => {
  for (let p = start; p < end; p++) if ((b[p] < 32 && ![9, 10, 13].includes(b[p])) || b[p] === 127) return false;
  return true;
};
// CRC work is linear in the input, with a constant-size lookup table.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(b: Uint8Array, start: number, end: number): number {
  let value = 0xffffffff;
  for (let p = start; p < end; p++) value = (value >>> 8) ^ crcTable[(value ^ b[p]) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

function png(b: Uint8Array): AttachmentImageVerdict {
  if (b.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v)) return 'unsupported';
  let p = 8, color = -1, depth = 0, palette = 0, data = false, dataBytes = 0, dataEnded = false, withheld = false;
  const seen = new Set<string>();
  while (p < b.length) {
    if (b.length - p < 12) return 'unsupported';
    const size = u32be(b, p), start = p + 8, end = start + size;
    if (end > b.length - 4) return 'unsupported';
    const kind = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind) || crc32(b, p + 4, end) !== u32be(b, end)) return 'unsupported';
    if (color < 0 && kind !== 'IHDR') return 'unsupported';
    if (data && kind !== 'IDAT') dataEnded = true;
    switch (kind) {
      case 'IHDR': {
        if (color >= 0 || size !== 13 || !u32be(b, start) || !u32be(b, start + 4) ||
          u32be(b, start) > 0x7fffffff || u32be(b, start + 4) > 0x7fffffff) return 'unsupported';
        depth = b[start + 8]; color = b[start + 9];
        const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!depths[color]?.includes(depth) || b[start + 10] || b[start + 11] || b[start + 12] > 1) return 'unsupported';
        break;
      }
      case 'PLTE':
        if (palette || data || [0, 4].includes(color) || !size || size % 3 || size > 768 || (color === 3 && size / 3 > 2 ** depth)) return 'unsupported';
        palette = size / 3; break;
      case 'IDAT':
        if (dataEnded || (color === 3 && !palette)) return 'unsupported';
        data = true; dataBytes += size; break;
      case 'IEND':
        if (size || !dataBytes || end + 4 !== b.length) return 'unsupported';
        return withheld ? 'withheld' : 'available';
      case 'tEXt': {
        // Only one contiguous plain Latin-1 value, already scanned by the host.
        let separator = start;
        while (separator < end && b[separator]) separator++;
        if (separator === end || separator - start < 1 || separator - start > 79) return 'unsupported';
        if (!plainText(b, start, separator) || !plainText(b, separator + 1, end)) withheld = true;
        break;
      }
      case 'zTXt': case 'iTXt': case 'iCCP': case 'eXIf':
        // Also withhold uncompressed iTXt: the alternate encodings are not part
        // of this gate's plain-text contract. Never attempt partial inflation.
        withheld = true; break;
      case 'cHRM': case 'gAMA': case 'sRGB': case 'pHYs': case 'tIME': case 'sBIT': case 'bKGD': case 'tRNS': {
        if (seen.has(kind)) return 'unsupported';
        seen.add(kind);
        const lengths: Record<string, number> = { cHRM: 32, gAMA: 4, sRGB: 1, pHYs: 9, tIME: 7,
          sBIT: ({ 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 } as Record<number, number>)[color],
          bKGD: color === 3 ? 1 : [0, 4].includes(color) ? 2 : 6 };
        if (kind === 'tRNS') {
          if (data || (color === 3 ? !palette || !size || size > palette : size !== (color === 0 ? 2 : color === 2 ? 6 : -1))) return 'unsupported';
        } else if (size !== lengths[kind] || (data && kind !== 'tIME')) return 'unsupported';
        if ((kind === 'sRGB' && b[start] > 3) || (kind === 'pHYs' && b[start + 8] > 1)) return 'unsupported';
        break;
      }
      default:
        // An unrecognized critical chunk cannot be decoded by this policy.
        if (!(b[p + 4] & 32)) return 'unsupported';
        withheld = true;
    }
    p = end + 4;
  }
  return 'unsupported';
}

function jpeg(b: Uint8Array): AttachmentImageVerdict {
  if (b.length < 4 || b[0] !== 255 || b[1] !== 216) return 'unsupported';
  let p = 2, frame = false, scan = false, withheld = false;
  while (p < b.length) {
    if (b[p++] !== 255) return 'unsupported';
    while (p < b.length && b[p] === 255) p++;
    if (p === b.length) return 'unsupported';
    const marker = b[p++];
    if (marker === 0xd9) return frame && scan && p === b.length ? withheld ? 'withheld' : 'available' : 'unsupported';
    if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) return 'unsupported';
    if (b.length - p < 2) return 'unsupported';
    const size = u16be(b, p), start = p + 2, end = p + size;
    if (size < 2 || end > b.length) return 'unsupported';
    if (marker >= 0xe0 && marker <= 0xef) {
      // JFIF's thumbnail is raw RGB pixels, with its exact size attested here.
      // Adobe APP14 is a fixed 12-byte colour transform record. All other APPn
      // payloads, including Exif, ICC, XMP and nested thumbnails, are opaque.
      if (marker === 0xe0 && ascii(b, start, 'JFIF\0')) {
        if (end - start < 14 || b[start + 5] !== 1 || b[start + 6] > 2 || b[start + 7] > 2 ||
          end - start !== 14 + 3 * b[start + 12] * b[start + 13]) return 'unsupported';
      } else if (marker === 0xee && ascii(b, start, 'Adobe')) {
        if (end - start !== 12 || b[start + 11] > 2) return 'unsupported';
      } else withheld = true;
    } else if (marker === 0xfe) {
      if (!plainText(b, start, end)) withheld = true;
    } else if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const count = b[start + 5];
      if (frame || end - start < 6 || ![8, 12].includes(b[start]) || !u16be(b, start + 1) ||
        !u16be(b, start + 3) || count < 1 || count > 4 || end - start !== 6 + 3 * count) return 'unsupported';
      frame = true;
    } else if (marker === 0xdb) {
      let q = start;
      while (q < end) {
        const info = b[q++];
        if ((info >> 4) > 1 || (info & 15) > 3) return 'unsupported';
        q += (info >> 4) ? 128 : 64;
        if (q > end) return 'unsupported';
      }
      if (q === start) return 'unsupported';
    } else if (marker === 0xc4) {
      let q = start;
      while (q < end) {
        const info = b[q++];
        if ((info >> 4) > 1 || (info & 15) > 3 || end - q < 16) return 'unsupported';
        let symbols = 0;
        for (let i = 0; i < 16; i++) symbols += b[q++];
        if (!symbols || symbols > 256 || q + symbols > end) return 'unsupported';
        q += symbols;
      }
      if (q === start) return 'unsupported';
    } else if (marker === 0xdd || marker === 0xdc) {
      if (end - start !== 2) return 'unsupported';
    } else if (marker === 0xda) {
      const count = b[start];
      if (!frame || count < 1 || count > 4 || end - start !== 4 + 2 * count) return 'unsupported';
      scan = true; p = end;
      // Entropy bytes, FF00 escapes and restart markers are pixel data. Stop at
      // every other marker so metadata between progressive scans is inspected.
      let pixelBytes = 0;
      while (p < b.length) {
        if (b[p] !== 255) { p++; pixelBytes++; continue; }
        const markerStart = p++;
        while (p < b.length && b[p] === 255) p++;
        if (p === b.length) return 'unsupported';
        if (b[p] === 0 || (b[p] >= 0xd0 && b[p] <= 0xd7)) { p++; pixelBytes++; continue; }
        p = markerStart; break;
      }
      if (!pixelBytes) return 'unsupported';
      continue;
    } else return 'unsupported';
    p = end;
  }
  return 'unsupported';
}

function gif(b: Uint8Array): AttachmentImageVerdict {
  if (b.length < 13 || (!ascii(b, 0, 'GIF87a') && !ascii(b, 0, 'GIF89a')) || !u16le(b, 6) || !u16le(b, 8)) return 'unsupported';
  let p = 13, images = 0, withheld = false;
  if (b[10] & 128) p += 3 * (2 << (b[10] & 7));
  if (p > b.length) return 'unsupported';
  function blocks(): boolean {
    while (p < b.length) {
      const size = b[p++];
      if (!size) return true;
      if (size > b.length - p) return false;
      p += size;
    }
    return false;
  }
  while (p < b.length) {
    const introducer = b[p++];
    if (introducer === 0x3b) return images && p === b.length ? withheld ? 'withheld' : 'available' : 'unsupported';
    if (introducer === 0x2c) {
      if (b.length - p < 9 || !u16le(b, p + 4) || !u16le(b, p + 6) || (b[p + 8] & 24)) return 'unsupported';
      const packed = b[p + 8]; p += 9;
      if (packed & 128) p += 3 * (2 << (packed & 7));
      if (p >= b.length || b[p] < 2 || b[p] > 8) return 'unsupported';
      p++;
      if (p >= b.length || b[p] === 0 || !blocks()) return 'unsupported';
      images++; continue;
    }
    if (introducer !== 0x21 || p >= b.length) return 'unsupported';
    const label = b[p++];
    if (label === 0xf9) {
      if (b.length - p < 6 || b[p] !== 4 || (b[p + 1] & 0xe0) || ((b[p + 1] >> 2) & 7) > 3 || b[p + 5]) return 'unsupported';
      p += 6;
    } else if (label === 0xff) {
      if (p >= b.length || b[p++] !== 11 || b.length - p < 11) return 'unsupported';
      const loop = ascii(b, p, 'NETSCAPE2.0'); p += 11;
      // The usual animation loop record contains only a fixed 16-bit count.
      if (loop && b.length - p >= 5 && b[p] === 3 && b[p + 1] === 1 && b[p + 4] === 0) p += 5;
      else { withheld = true; if (!blocks()) return 'unsupported'; }
    } else if (label === 0xfe) {
      // Block separators can split a secret across fragments in the raw scan.
      withheld = true; if (!blocks()) return 'unsupported';
    } else if (label === 0x01) {
      if (p >= b.length || b[p++] !== 12 || b.length - p < 12) return 'unsupported';
      p += 12; withheld = true; if (!blocks()) return 'unsupported';
    } else {
      withheld = true; if (!blocks()) return 'unsupported';
    }
  }
  return 'unsupported';
}

function webp(b: Uint8Array): AttachmentImageVerdict {
  if (b.length < 12 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP') || u32le(b, 4) !== b.length - 8) return 'unsupported';
  let extended = false, animation = false, image = false, animHeader = false, withheld = false;
  function chunks(start: number, end: number, frame: boolean): boolean {
    let p = start, pixels = false, alpha = false;
    while (p < end) {
      if (end - p < 8) return false;
      const size = u32le(b, p + 4), data = p + 8, next = data + size + (size & 1);
      if (next > end || ((size & 1) && b[next - 1] !== 0)) return false;
      const kind = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      switch (kind) {
        case 'VP8 ': case 'VP8L':
          if (pixels || (!frame && image) || (alpha && kind === 'VP8L') || (!frame && animation)) return false;
          if (kind === 'VP8L') {
            if (size <= 5 || b[data] !== 0x2f || (b[data + 4] & 0xe0)) return false;
          } else if (size <= 10 || (b[data] & 1) || !ascii(b, data + 3, '\x9d\x01\x2a') ||
            !(u16le(b, data + 6) & 0x3fff) || !(u16le(b, data + 8) & 0x3fff)) return false;
          pixels = true; if (!frame) image = true; break;
        case 'ALPH':
          if (!size || alpha || pixels || (!frame && !extended) || (b[data] & 0xc0) || (b[data] & 3) > 1 || ((b[data] >> 4) & 3) > 1) return false;
          alpha = true; break;
        case 'VP8X':
          if (frame || extended || p !== 12 || size !== 10 || (b[data] & 0xc1) || b[data + 1] || b[data + 2] || b[data + 3]) return false;
          extended = true; animation = !!(b[data] & 2);
          if (b[data] & 0x2c) withheld = true; // ICC, Exif or XMP advertised.
          break;
        case 'ANIM':
          if (frame || !animation || animHeader || image || size !== 6) return false;
          animHeader = true; break;
        case 'ANMF':
          if (frame || !animHeader || size < 16 || (b[data + 15] & 0xfc)) return false;
          if (2 * u24le(b, data) + u24le(b, data + 6) + 1 > u24le(b, 24) + 1 ||
            2 * u24le(b, data + 3) + u24le(b, data + 9) + 1 > u24le(b, 27) + 1 ||
            !chunks(data + 16, data + size, true)) return false;
          image = true; break;
        case 'ICCP': case 'EXIF': case 'XMP ': withheld = true; break;
        default: withheld = true;
      }
      p = next;
    }
    return p === end && (!frame || pixels) && (!alpha || pixels);
  }
  return chunks(12, b.length, false) && image ? withheld ? 'withheld' : 'available' : 'unsupported';
}

/** Call only after complete host policy inspection, before retaining/exporting
 * bytes. Exact MIME names intentionally match the attachment host contract. */
export function inspectAttachmentImage(bytes: Uint8Array, mimeType: string): AttachmentImageVerdict {
  switch (mimeType) {
    case 'image/png': return png(bytes);
    case 'image/jpeg': return jpeg(bytes);
    case 'image/gif': return gif(bytes);
    case 'image/webp': return webp(bytes);
    default: return 'unsupported';
  }
}
