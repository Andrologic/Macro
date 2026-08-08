import { describe, expect, it } from 'bun:test';
import type { MCPServer } from '../../types';
import {
  buildMCPToolId,
  collectMCPEnvSecretRefs,
  formatMCPEnvForEdit,
  normalizeMCPServer,
  parseMCPArgs,
  parseMCPEnv,
  selectInjectableMCPToolIds,
  toMCPFunctionToolShape,
} from './index';

describe('MCP domain helpers', () => {
  it('builds stable namespaced tool ids and normalizes server tools', () => {
    expect(buildMCPToolId('GitHub Server', 'issues/list')).toBe(
      'mcp__github_server__issues_list'
    );

    const server = normalizeMCPServer({
      id: 'GitHub Server',
      name: 'GitHub Server',
      category: 'development',
      status: 'online',
      description: 'GitHub MCP',
      icon: 'server',
      config: { enabled: true },
      tools: [
        {
          id: '',
          serverId: '',
          name: 'issues/list',
        },
      ],
    });

    expect(server.id).toBe('github_server');
    expect(server.tools?.[0]).toMatchObject({
      id: 'mcp__github_server__issues_list',
      serverId: 'github_server',
      enabled: true,
      inputSchema: { type: 'object', properties: {} },
    });
  });

  it('parses args and preserves masked env secret refs', () => {
    expect(parseMCPArgs('["-y","server","."]')).toEqual(['-y', 'server', '.']);
    expect(parseMCPArgs('-y server .')).toEqual(['-y', 'server', '.']);

    const previousEnv = {
      API_TOKEN: 'macro-secret://mcp-env/github/API_TOKEN',
      DEBUG: '1',
    };
    expect(formatMCPEnvForEdit(previousEnv)).toBe('API_TOKEN=********\nDEBUG=1');
    expect(parseMCPEnv('API_TOKEN=********\nDEBUG=0', previousEnv)).toEqual({
      API_TOKEN: 'macro-secret://mcp-env/github/API_TOKEN',
      DEBUG: '0',
    });
  });

  it('collects secret refs and converts MCP tools to function tools', () => {
    const servers: Record<string, MCPServer> = {
      github: {
        id: 'github',
        name: 'GitHub',
        category: 'development',
        status: 'online',
        description: 'GitHub MCP',
        icon: 'server',
        transport: {
          type: 'stdio',
          command: 'npx',
          env: { API_TOKEN: 'macro-secret://mcp-env/github/API_TOKEN' },
        },
        config: { enabled: true },
      },
    };

    expect(Array.from(collectMCPEnvSecretRefs(servers).values())).toEqual([
      { serverId: 'github', key: 'API_TOKEN' },
    ]);
    expect(
      toMCPFunctionToolShape({
        id: 'mcp__github__list_issues',
        serverId: 'github',
        name: 'list_issues',
        description: 'List issues',
        inputSchema: { type: 'object', properties: { state: { type: 'string' } } },
      })
    ).toMatchObject({
      type: 'function',
      function: {
        name: 'mcp__github__list_issues',
        parameters: { type: 'object', properties: { state: { type: 'string' } } },
      },
    });
  });

  it('selects injectable MCP tools only for compatible provider and agent contexts', () => {
    const enabledToolIds = ['mcp__github__list_issues'];

    expect(
      selectInjectableMCPToolIds({
        enabledToolIds,
        supportsNativeToolCalling: true,
        providerType: 'openai',
        mode: 'Chat',
      })
    ).toEqual(enabledToolIds);
    expect(
      selectInjectableMCPToolIds({
        enabledToolIds,
        supportsNativeToolCalling: false,
        providerType: 'openai',
        mode: 'Chat',
      })
    ).toEqual([]);
    expect(
      selectInjectableMCPToolIds({
        enabledToolIds,
        supportsNativeToolCalling: true,
        providerType: 'copilot',
        mode: 'Chat',
      })
    ).toEqual([]);
    expect(
      selectInjectableMCPToolIds({
        enabledToolIds,
        supportsNativeToolCalling: true,
        providerType: 'openai',
        mode: 'Implement',
        agentType: 'plan',
      })
    ).toEqual([]);
  });
});
