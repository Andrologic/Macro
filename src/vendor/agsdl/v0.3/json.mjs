// SPDX-License-Identifier: Apache-2.0
// Adapted from AgSDL v0.3.0 tooling/agsdl/jsoninput.py and the AgSDL JS scanner.
// Upstream: https://github.com/Andrologic/AgSDL, see the adjacent LICENSE.
// Browser adaptation: iterative container traversal; shared 0.2 execution token identity.
import { NumberToken } from '../v0.2/json.mjs';
import { ParseError, pointer } from '../experimental/readers/javascript/json.mjs';
export { NumberToken, ParseError, pointer };
export { stringify } from './values.mjs';

export function parse(bytes) {
  const b = new Uint8Array(bytes), spans = new Map();
  let i = 0;
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
  // A frame records the next delimiter/key expected, without using the JS call stack.
  const frames = [];
  let tree;
  function value(path) {
    ws();
    const start = i;
    let v;
    if (b[i] === 123 || b[i] === 91) {
      const object = b[i++] === 123;
      v = object ? Object.create(null) : [];
      frames.push({ v, path, start, object, state: 'first' });
    } else {
      if (b[i] === 34) v = string();
      else if ([116, 102, 110].includes(b[i])) {
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
      spans.set(path, { start, end: i });
    }
    return v;
  }
  try {
    tree = value('');
    while (frames.length) {
      const f = frames[frames.length - 1];
      ws();
      const close = f.object ? 125 : 93;
      if (f.state === 'after') {
        if (b[i] === 44) { i++; f.state = 'next'; ws(); }
        else if (b[i] !== close) bad();
      }
      if (b[i] === close && f.state !== 'next') {
        i++;
        spans.set(f.path, { start: f.start, end: i });
        frames.pop();
        continue;
      }
      let key = f.v.length;
      if (f.object) {
        if (b[i] !== 34) bad();
        const keyAt = i;
        key = string();
        if (Object.hasOwn(f.v, key)) bad(keyAt);
        ws();
        if (b[i++] !== 58) bad(i - 1);
      }
      f.state = 'after';
      f.v[key] = value(pointer(f.path, key));
    }
    ws();
    if (i !== b.length) bad();
    return { tree, spans, bytes: b };
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    return { tree: null, spans: new Map(), bytes: b, error };
  }
}
