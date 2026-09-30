import type { MCPServer } from "../../types";
import type { MCPRuntimeKey } from "../contracts/serviceProvider";

const runtimeKey = Symbol("scopedMcpRuntimeKey");
type RuntimeBoundMcpServer = MCPServer & { [runtimeKey]?: MCPRuntimeKey };

export const bindMcpRuntimeKey = (server: MCPServer, key: MCPRuntimeKey): MCPServer => {
  Object.defineProperty(server, runtimeKey, { value: key, enumerable: false });
  return server;
};

export const readMcpRuntimeKey = (server: MCPServer): MCPRuntimeKey | undefined =>
  (server as RuntimeBoundMcpServer)[runtimeKey];

/** Preserve the opaque backend generation while isolating mutable turn data. */
export const snapshotScopedMcpServers = (servers: readonly MCPServer[]): MCPServer[] =>
  servers.map((server) => {
    const snapshot = structuredClone(server);
    const key = readMcpRuntimeKey(server);
    return key ? bindMcpRuntimeKey(snapshot, structuredClone(key)) : snapshot;
  });
