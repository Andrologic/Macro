import type { MCPServer } from '../../types';
import { isMCPEnvSecretRef, isSensitiveMCPEnvKey } from './envSecrets';

export type MCPSecretWriter = (params: {
  serverId: string;
  key: string;
  value: string;
}) => Promise<string>;

const secureEntries = async (
  serverId: string,
  entries: Record<string, string>,
  storeSecret: MCPSecretWriter
): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(entries).map(async ([key, value]) => {
        if (!isSensitiveMCPEnvKey(key) || !value || isMCPEnvSecretRef(value)) {
          return [key, value] as const;
        }
        return [key, await storeSecret({ serverId, key, value })] as const;
      })
    )
  );

export const secureMCPServerSecrets = async (
  servers: Record<string, MCPServer>,
  storeSecret: MCPSecretWriter
): Promise<Record<string, MCPServer>> => {
  const securedEntries = await Promise.all(
    Object.entries(servers).map(async ([id, server]) => {
      if (server.transport?.type === 'stdio') {
        return [
          id,
          {
            ...server,
            transport: {
              ...server.transport,
              env: await secureEntries(server.id, server.transport.env ?? {}, storeSecret),
            },
          },
        ] as const;
      }
      if (server.transport?.type === 'streamable_http') {
        return [
          id,
          {
            ...server,
            transport: {
              ...server.transport,
              headers: await secureEntries(
                server.id,
                server.transport.headers ?? {},
                storeSecret
              ),
            },
          },
        ] as const;
      }
      return [id, server] as const;
    })
  );
  return Object.fromEntries(securedEntries);
};
