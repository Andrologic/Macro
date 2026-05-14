import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAppStateGetter } from './appStateRuntime';
import { BunExtensionSidecarHost } from './extensionSidecarHost.node';
import { createDevelopmentExtension, macroContributionRegistry } from './extensions';
import { grantAllRequestedExtensionPermissions } from './extensionTrust';

const manifest = {
  id: 'sidecar.macro',
  name: 'Sidecar Macro',
  version: '1.0.0',
  main: './extension.mjs',
  contributes: {
    commands: [{ id: 'sidecar.macro.ping', title: 'Ping' }],
    tools: [{ id: 'sidecar.macro.echo', description: 'Echo', risk: 'read' }],
  },
  permissions: { workspace: ['read'], commands: ['register'], ai: ['tools'] },
};

afterEach(() => {
  macroContributionRegistry.unregisterExtension('sidecar.macro');
});

describe('BunExtensionSidecarHost', () => {
  it('activates an extension and executes registered commands and tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'macro-sidecar-test-'));
    const mainPath = join(dir, 'extension.mjs');
    await writeFile(
      mainPath,
      [
        'export async function activate(context, macro) {',
        '  context.subscriptions.push(macro.commands.registerCommand("sidecar.macro.ping", async () => ({ pong: true })));',
        '  context.subscriptions.push(macro.tools.registerTool({ id: "sidecar.macro.echo" }, async (input) => input));',
        '}',
      ].join('\n'),
      'utf8',
    );

    registerAppStateGetter(() => ({ projectGroups: [] }));
    macroContributionRegistry.registerExtension(
      createDevelopmentExtension(manifest, grantAllRequestedExtensionPermissions(manifest)),
    );

    const host = new BunExtensionSidecarHost();
    try {
      await host.activate('sidecar.macro', mainPath);
      expect(await host.executeCommand('sidecar.macro.ping')).toEqual({ pong: true });
      expect(await host.executeTool('sidecar.macro.echo', { ok: true })).toEqual({ ok: true });
    } finally {
      host.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects tool registration when the extension was not granted tool permission', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'macro-sidecar-test-'));
    const mainPath = join(dir, 'extension.mjs');
    await writeFile(
      mainPath,
      [
        'export async function activate(context, macro) {',
        '  context.subscriptions.push(macro.tools.registerTool({ id: "sidecar.macro.echo" }, async (input) => input));',
        '}',
      ].join('\n'),
      'utf8',
    );

    const restrictedManifest = {
      ...manifest,
      permissions: { workspace: ['read'], commands: ['register'] },
    };
    macroContributionRegistry.registerExtension(
      createDevelopmentExtension(
        restrictedManifest,
        grantAllRequestedExtensionPermissions(restrictedManifest),
      ),
    );

    const host = new BunExtensionSidecarHost();
    try {
      await expect(host.activate('sidecar.macro', mainPath)).rejects.toThrow(/tool registration/i);
    } finally {
      host.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
