import { describe, expect, it, mock } from 'bun:test';
import type { MCPServer } from '../types';
import { callScopedMcpTool, resolveScopedMcpRuntime } from './scopedMcpRuntime';

describe('scoped MCP runtime', () => {
  it('discovers and calls a project-only server without mutating the global store', async () => {
    const discover = mock(async (server: MCPServer) => ({
      tools: [{
        id: `mcp__${server.id}__list`,
        serverId: server.id,
        name: 'list',
        enabled: true,
      }],
    }));
    const runtime = await resolveScopedMcpRuntime({
      project_docs: {
        enabled: true,
        name: 'Project docs',
        transport: { type: 'stdio', command: 'project-docs' },
      },
    }, [], discover);

    expect(discover).toHaveBeenCalledTimes(1);
    expect(runtime.tools.map((tool) => tool.id)).toEqual(['mcp__project_docs__list']);

    const call = mock(async () => ({ content: 'project result' }));
    await expect(callScopedMcpTool(
      'mcp__project_docs__list',
      { limit: 5 },
      runtime.servers,
      call,
    )).resolves.toBe('project result');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('reuses an online global runtime only when its transport matches', async () => {
    const fallback: MCPServer = {
      id: 'shared_docs',
      name: 'Shared docs',
      description: '',
      category: 'other',
      icon: 'server',
      status: 'online',
      transport: { type: 'stdio', command: 'shared-docs' },
      config: { enabled: true },
      tools: [{ id: 'mcp__shared_docs__read', serverId: 'shared_docs', name: 'read' }],
    };
    const discover = mock(async () => ({ tools: [] }));
    const runtime = await resolveScopedMcpRuntime({
      shared_docs: {
        enabled: true,
        transport: { type: 'stdio', command: 'shared-docs' },
      },
    }, [fallback], discover);

    expect(discover).not.toHaveBeenCalled();
    expect(runtime.tools.map((tool) => tool.id)).toEqual(['mcp__shared_docs__read']);
  });
});
