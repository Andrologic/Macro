import { expect,it } from 'bun:test';
import { createEmptySystemDocument } from './design';
import { applyChanges,isSupportedContract,validateDocument } from './document';
import { createExample } from './examples';
import { projectViewer } from './viewer';

it('refuses 0.2 viewing, structured editing and creation without changing the source', async () => {
  const source = '{"contract":"agsdl-0.2.0","id":"old","agents":{},"configurations":{},"bindings":{},"content":{"n":{"value":9007199254740993}}}';
  expect(isSupportedContract('agsdl-0.2.0')).toBe(false);
  expect(() => projectViewer(source)).toThrow('agsdl.unsupportedEdition020');
  expect(() => applyChanges(source, [{ op: 'set', path: '/id', valueJson: '"changed"' }])).toThrow('supported AgSDL edition');
  expect(() => createEmptySystemDocument('Old', 'agsdl-0.2.0')).toThrow('Unsupported AgSDL authoring contract');
  expect(() => createExample('feature', 'agsdl-0.2.0')).toThrow('agsdl.unsupportedEdition020');
  const [report] = await validateDocument(source);
  expect(report.scope).toBe('unsupported-contract');
  expect(report.results[0].findings[0].rule).toBe('UNSUPPORTED_CONTRACT');
  expect(source).toContain('9007199254740993');
});
