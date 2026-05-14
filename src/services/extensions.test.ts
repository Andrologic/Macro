import { describe, expect, it } from 'bun:test';
import {
  createDevelopmentExtension,
  macroContributionRegistry,
  parseMacroExtensionManifest,
  validateMacroExtensionManifest,
} from './extensions';
import { grantAllRequestedExtensionPermissions } from './extensionTrust';

const manifestJson = JSON.stringify({
  id: 'test.macro',
  name: 'Test Macro',
  version: '1.0.0',
  main: './dist/extension.mjs',
  contributes: {
    modes: [{ id: 'test.macro.mode', label: 'Test', layout: { center: 'test.macro.graph' } }],
    views: [{ id: 'test.macro.graph', title: 'Graph', kind: 'graph', location: 'centerPanel' }],
    commands: [{ id: 'test.macro.refresh', title: 'Refresh' }],
    tools: [{ id: 'test.macro.index', description: 'Index', risk: 'read' }],
  },
  permissions: { workspace: ['read'], ui: ['modes', 'views'] },
});

describe('Macro extension manifest registry', () => {
  it('validates and registers namespaced extension contributions', () => {
    const manifest = parseMacroExtensionManifest(manifestJson);
    expect(validateMacroExtensionManifest(manifest).valid).toBe(true);

    macroContributionRegistry.registerExtension(
      createDevelopmentExtension(manifest, grantAllRequestedExtensionPermissions(manifest)),
    );

    expect(macroContributionRegistry.getMode('test.macro.mode')?.extensionId).toBe('test.macro');
    expect(macroContributionRegistry.getView('test.macro.graph')?.contribution.kind).toBe('graph');

    macroContributionRegistry.unregisterExtension('test.macro');
  });

  it('rejects unsafe package paths', () => {
    const manifest = parseMacroExtensionManifest(
      JSON.stringify({ id: 'bad.macro', name: 'Bad', version: '1.0.0', main: '../extension.mjs' }),
    );

    expect(validateMacroExtensionManifest(manifest).errors.join('\n')).toContain('traversal');
  });
});
