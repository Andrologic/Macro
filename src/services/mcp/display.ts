import type { MCPServer, MCPServerStatus } from '../../types';

export const MCP_STATUS_STYLES: Record<MCPServerStatus, string> = {
  online: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  degraded: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  offline: 'bg-muted text-muted-foreground border-border',
  unconfigured: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
};

export const getMCPStatusLabel = (status: MCPServerStatus): string => {
  switch (status) {
    case 'online':
      return 'Online';
    case 'degraded':
      return 'Degraded';
    case 'offline':
      return 'Offline';
    case 'unconfigured':
      return 'Unconfigured';
  }
};

export const summarizeMCPServerCommand = (server: MCPServer): string => {
  if (server.transport?.type !== 'stdio') {
    return server.description;
  }
  return [server.transport.command, ...(server.transport.args ?? [])]
    .filter(Boolean)
    .join(' ');
};
