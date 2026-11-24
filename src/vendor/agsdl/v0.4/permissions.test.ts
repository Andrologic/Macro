import { describe, expect, test } from 'bun:test';
import { ACTIONS, normalize, outside, covers_all, shell_denied, glob_matches, effect_for, command_prefix, effects_in_use } from './permissions.mjs';
import type { Permissions } from './permissions.mjs';

describe('AgSDL 0.3 static permissions', () => {
  test('normalizes presets and preserves explicit outside policy', () => {
    expect(normalize(null)).toEqual([null, []]);
    expect(normalize('workspace')).toEqual(['workspace', []]);
    expect(outside('full')).toBe('read');
    expect(outside({ preset: 'full', outside: 'deny' })).toBe('deny');
    expect(outside({ outside: 'read' })).toBe('read');
    expect(outside(null)).toBe('deny');
  });
  test('distinguishes workspace patterns from every absolute path', () => {
    expect(covers_all({ action: 'read', effect: 'deny', match: '**' })).toBe(false);
    expect(covers_all({ action: 'write', effect: 'deny', match: '/**' })).toBe(true);
    expect(covers_all({ action: 'shell', effect: 'deny', match: '**' })).toBe(true);
    expect(covers_all({ action: 'shell', effect: 'deny', match: '' })).toBe(false);
    expect(covers_all({ action: 'delegate', effect: 'deny' })).toBe(true);
  });
  test('matches glob characters literally except the specified stars', () => {
    for (const [pattern, subject, paths, command, matches] of [
      ['*.ts', 'a/b.ts', true, false, false], ['**.ts', 'a/b.ts', true, false, true],
      ['a/**/b', 'a/b', true, false, false], ['git push *', 'git push', false, true, true],
      ['git push *', 'git push origin', false, true, true], ['git push *', 'git pushx', false, true, false],
      ['a.b[0](x)+?^$|\\', 'a.b[0](x)+?^$|\\', false, false, true],
      ['literal', 'literal\n', false, false, false], ['*', 'x\ny😀', false, false, true],
      ['a*', 'a\nb', true, false, true], ['**', 'x/y', false, false, true],
    ] as const) expect(glob_matches(pattern, subject, paths, command)).toBe(matches);
  });
  test('uses deny then ask then allow, with no exception to a matching deny', () => {
    const p: Permissions = { preset: 'full', rules: [
      { action: 'shell', match: 'git *', effect: 'ask' },
      { action: 'shell', match: 'git push *', effect: 'deny' },
      { action: 'shell', match: 'git push origin', effect: 'allow' },
    ] };
    expect(effect_for(p, 'shell', 'git push origin')).toBe('deny');
    expect(effect_for(p, 'shell', 'git status')).toBe('ask');
    expect(effect_for(p, 'shell', 'echo ok')).toBe('allow');
    expect(effect_for(null, 'read', 'file')).toBe('deny');
    expect(effect_for({ rules: [{ action: 'network', effect: 'allow' }] }, 'network', 'example.org')).toBe('allow');
  });
  test('identifies total shell denial separately from partial denial', () => {
    expect(shell_denied(null)).toBe(true);
    expect(shell_denied('workspace')).toBe(false);
    expect(shell_denied({ preset: 'full', rules: [{ action: 'shell', effect: 'deny', match: '*' }] })).toBe(true);
    expect(shell_denied({ preset: 'read-only', rules: [{ action: 'shell', effect: 'ask', match: 'git *' }] })).toBe(false);
    expect(shell_denied({ rules: [{ action: 'shell', effect: 'deny', match: 'git *' }] })).toBe(true);
  });
  test('command prefixes follow Python whitespace and permit only a final star argument', () => {
    for (const p of ['git push', 'git push *', 'a\tb', '\ufeffcmd']) expect(command_prefix(p)).toBe(true);
    for (const p of ['', '*', 'git*', 'git * status', ' git', 'git ', '\u0085git', 'git\u001f']) expect(command_prefix(p)).toBe(false);
  });
  test('enumerates defaults, workspace write denials and covering rules', () => {
    expect(Object.keys(effects_in_use(null))).toEqual([...ACTIONS]);
    expect(effects_in_use('workspace').write).toEqual(new Set(['allow', 'deny']));
    expect(effects_in_use({ preset: 'workspace', rules: [{ action: 'write', match: '**', effect: 'ask' }] }).write).toEqual(new Set(['ask', 'allow', 'deny']));
    expect(effects_in_use({ preset: 'full', rules: [{ action: 'read', match: '/**', effect: 'ask' }] }).read).toEqual(new Set(['ask']));
    expect(effects_in_use({ rules: [{ action: 'delegate', effect: 'allow' }] }).delegate).toEqual(new Set(['allow']));
  });
});
