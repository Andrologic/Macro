import { expect, test } from 'bun:test';
import { agsdlExport } from './exportDocument';

test('source export preserves authored bytes and does not embed Macro metadata', () => {
  const source = '{\n  "contract": "agsdl-0.2.0"\n}\n';
  const file = agsdlExport(source, { 'notes.txt': 'evidence' }, { display: { title: 'Private title' } }, '../Cellule de crise', 'source');
  expect(file.content).toBe(source);
  expect(file.filename).toBe('Cellule-de-crise.agsdl.json');
});
test('complete export preserves annexes and editor metadata without adding them to the AgSDL document', () => {
  const source = '{"contract":"agsdl-0.2.0"}';
  const metadata = { display: { title: 'Cellule de crise', cards: { '/flow/steps/one': { title: 'Analyse' } } } };
  const file = agsdlExport(source, { 'notes.txt': 'preuve accentuée' }, metadata, 'Cellule de crise', 'macro');
  expect(JSON.parse(file.content)).toEqual({ format: 'macro-agsdl-export', version: 1, name: 'Cellule de crise', agsdl: { source, annexes: { 'notes.txt': 'preuve accentuée' }, ...metadata } });
  expect(file.filename).toBe('Cellule-de-crise.macro-system.json');
});
