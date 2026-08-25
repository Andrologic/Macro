import { describe, expect, it, mock } from 'bun:test';
import { normalizeMCPServerSettingsInput } from './clientSettingsStorage';
import { secureMCPServerSecrets } from '../mcp/secureSecrets';

describe('IPC MCP secret persistence', () => {
  it('moves sensitive Streamable HTTP headers into the native secret store', async () => {
    const storeSecret = mock(async ({ serverId, key }: { serverId: string; key: string }) =>
      `macro-secret://mcp-env/${serverId}/${key}`
    );
    const servers = normalizeMCPServerSettingsInput({
      servers: {
        remote: {
          id: 'remote',
          name: 'Remote',
          category: 'development',
          description: 'Remote MCP',
          icon: 'server',
          status: 'offline',
          config: { enabled: true },
          transport: {
            type: 'streamable_http',
            url: 'https://mcp.example.com/mcp',
            headers: {
              Authorization: 'Bearer secret-token',
              'X-API-Key': 'secret-api-key',
              'X-Tenant': 'public-tenant',
            },
          },
        },
      },
    });

    const secured = await secureMCPServerSecrets(servers, storeSecret);

    expect(secured.remote?.transport).toEqual({
      type: 'streamable_http',
      url: 'https://mcp.example.com/mcp',
      headers: {
        Authorization: 'macro-secret://mcp-env/remote/Authorization',
        'X-API-Key': 'macro-secret://mcp-env/remote/X-API-Key',
        'X-Tenant': 'public-tenant',
      },
    });
    expect(storeSecret).toHaveBeenCalledTimes(2);
  });
});
