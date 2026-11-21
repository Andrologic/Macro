// Browser adaptation: Uint8Array and TextDecoder replace Buffer.
// Byte-oriented JSON scanner: number tokens never pass through binary floats.
export class NumberToken {
  constructor(raw) { this.raw = raw; }
}
export class ParseError extends Error {
  constructor(byte) { super(`Invalid JSON at byte ${byte}`); this.byte = byte; }
}
export const pointer = (p, k) => `${p}/${String(k).replaceAll('~', '~0').replaceAll('/', '~1')}`;
export function parse(bytes) {
  const b = new Uint8Array(bytes), spans = new Map(); let i = 0;
  const bad = (at = i) => { throw new ParseError(at); };
  const ws = () => { while ([32, 9, 10, 13].includes(b[i])) i++; };
  function scalar() {
    const start = i, a = b[i++];
    if (a < 128) return String.fromCodePoint(a);
    const n = a >= 0xc2 && a <= 0xdf ? 1 : a >= 0xe0 && a <= 0xef ? 2 : a >= 0xf0 && a <= 0xf4 ? 3 : -1;
    if (n < 0) bad(start);
    let cp = a & (0x7f >> (n + 1));
    for (let j = 0; j < n; j++) {
      const c = b[i];
      if (c === undefined) bad(b.length);
      if (c < 0x80 || c > 0xbf) bad(i);
      if (j === 0 && ((a === 0xe0 && c < 0xa0) || (a === 0xed && c >= 0xa0) || (a === 0xf0 && c < 0x90) || (a === 0xf4 && c >= 0x90))) bad(i);
      cp = (cp << 6) | (c & 63); i++;
    }
    return String.fromCodePoint(cp);
  }
  function string() {
    i++; let s = '';
    function hex() {
      let h = '';
      for (let j = 0; j < 4; j++) { if (i === b.length) bad(); const c = String.fromCharCode(b[i]); if (!/[0-9a-fA-F]/.test(c)) bad(); h += c; i++; }
      return parseInt(h, 16);
    }
    while (i < b.length) {
      if (b[i] === 34) { i++; return s; }
      if (b[i] < 32) bad();
      if (b[i] !== 92) { s += scalar(); continue; }
      i++; const at = i, c = String.fromCharCode(b[i++]);
      const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (Object.hasOwn(escapes, c)) { s += escapes[c]; continue; }
      if (c !== 'u') bad(Math.min(at, b.length));
      let cp = hex();
      if (cp >= 0xd800 && cp <= 0xdbff) {
        if (b[i] !== 92 || b[i + 1] !== 117) bad(at - 1);
        i += 2;
        const low = hex(); if (low < 0xdc00 || low > 0xdfff) bad(at - 1);
        cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
      } else if (cp >= 0xdc00 && cp <= 0xdfff) bad(at - 1);
      s += String.fromCodePoint(cp);
    }
    bad();
  }
  function value(p) {
    ws(); const start = i; let v;
    if (b[i] === 34) v = string();
    else if (b[i] === 123) {
      i++; ws(); v = Object.create(null);
      if (b[i] !== 125) while (true) {
        if (b[i] !== 34) bad(); const keyAt = i, k = string();
        if (Object.hasOwn(v, k)) bad(keyAt); ws(); if (b[i++] !== 58) bad(i - 1);
        v[k] = value(pointer(p, k)); ws(); if (b[i] !== 44) break; i++; ws();
      }
      if (b[i] !== 125) bad(); i++;
    } else if (b[i] === 91) {
      i++; ws(); v = [];
      if (b[i] !== 93) while (true) { v.push(value(pointer(p, v.length))); ws(); if (b[i] !== 44) break; i++; }
      if (b[i] !== 93) bad(); i++;
    } else if ([116, 102, 110].includes(b[i])) {
      const literal = b[i] === 116 ? 'true' : b[i] === 102 ? 'false' : 'null';
      for (const c of literal) { if (b[i] !== c.charCodeAt(0)) bad(); i++; }
      v = literal === 'true' ? true : literal === 'false' ? false : null;
    } else if (b[i] === 45 || (b[i] >= 48 && b[i] <= 57)) {
      if (b[i] === 45) i++;
      if (b[i] === 48) i++;
      else { if (!(b[i] >= 49 && b[i] <= 57)) bad(); while (b[i] >= 48 && b[i] <= 57) i++; }
      if (b[i] === 46) { i++; if (!(b[i] >= 48 && b[i] <= 57)) bad(); while (b[i] >= 48 && b[i] <= 57) i++; }
      if (b[i] === 101 || b[i] === 69) { i++; if (b[i] === 43 || b[i] === 45) i++; if (!(b[i] >= 48 && b[i] <= 57)) bad(); while (b[i] >= 48 && b[i] <= 57) i++; }
      v = new NumberToken(new TextDecoder().decode(b.subarray(start, i)));
    } else bad();
    spans.set(p, { start, end: i }); return v;
  }
  try { const tree = value(''); ws(); if (i !== b.length) bad(); return { tree, spans, bytes: b }; }
  catch (error) { if (!(error instanceof ParseError)) throw error; return { tree: null, spans: new Map(), bytes: b, error }; }
}
export function stringify(v) {
  if (v instanceof NumberToken) return v.raw;
  if (Array.isArray(v)) return `[${v.map(stringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${stringify(x)}`).join(',')}}`;
  return JSON.stringify(v);
}
export function uint(v, positive = false) {
  if (!(v instanceof NumberToken)) return false;
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(v.raw);
  let digits = (m[2] + (m[3] || '')).replace(/^0+/, '');
  if (!digits) return !positive;
  if (m[1]) return false;
  const power = BigInt(m[4] || 0) - BigInt((m[3] || '').length);
  if (power >= 0n) { if (BigInt(digits.length) + power > 16n) return false; digits += '0'.repeat(Number(power)); }
  else { const n = -power; if (n > BigInt(digits.length)) return false; const count = Number(n); if (!/^0*$/.test(digits.slice(digits.length - count))) return false; digits = digits.slice(0, digits.length - count); }
  return BigInt(digits || '0') <= 9007199254740991n;
}
