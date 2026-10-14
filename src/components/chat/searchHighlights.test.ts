import { describe, expect, it } from 'bun:test';
import { splitSearchHighlights } from './searchHighlights';

describe('search highlights', () => {
  it('preserves accented text, combining marks and emoji while matching without accents', () => {
    const text = '🙂 Café et cafe\u0301, BÊTA.';
    const parts = splitSearchHighlights(text, 'cafe beta');
    expect(parts.map((part) => part.text).join('')).toBe(text);
    expect(parts.filter((part) => part.matched).map((part) => part.text)).toEqual(['Café', 'cafe\u0301', 'BÊTA']);
  });
  it('treats regex and HTML characters as literal text', () => {
    const parts = splitSearchHighlights('<script> a+b aab', 'a+b');
    expect(parts.filter((part) => part.matched).map((part) => part.text)).toEqual(['a+b']);
    expect(parts.map((part) => part.text).join('')).toBe('<script> a+b aab');
  });
});
