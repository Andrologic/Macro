import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { validateA1 } from './protocol';

describe('Pilot production A1 validator', () => {
  for (const group of ['valid', 'invalid']) {
    const directory = new URL(`../../../contracts/macro-pilot/v1/fixtures/${group}/`, import.meta.url);
    for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
      it(`${group}/${file}`, () => {
        expect(validateA1(JSON.parse(readFileSync(new URL(file, directory), 'utf8')))).toBe(group === 'valid');
      });
    }
  }
});
