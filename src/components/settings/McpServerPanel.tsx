import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMcpStore } from '../../stores/useMcpStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import type { McpServer, McpTransport } from '../../types/mcp';

/**
 * McpServerPanel - Manage MCP server configurations
 * 
 * Allows users to:
 * - Add new MCP servers
 * - Edit existing configurations
 * - Connect/disconnect from servers
 * - View available tools
 */
export const McpServerPanel: React.FC = () => {
  const { t } = useTranslation();
  const {
    servers,
    isLoading,
    lastError,
    loadServers,
    addServer,
    removeServer,
    connectServer,
    disconnectServer,
  } = useMcpStore();

  const [isAddingServer, setIsAddingServer] = useState(false);
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);

  // Load servers on mount
  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const serverList = Object.values(servers);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t('settings.mcpServers', 'MCP Servers')}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('settings.mcpServersDescription', 'Connect to Model Context Protocol servers for additional tools')}
          </p>
        </div>
        <button
          onClick={() => setIsAddingServer(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <Icon name="plus" size={12} />
          {t('common.add', 'Add')}
        </button>
      </div>

      {/* Error message */}
      {lastError && (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
          {lastError}
        </div>
      )}

      {/* Server list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Icon name="loader" size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : serverList.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          {t('settings.noMcpServers', 'No MCP servers configured')}
        </div>
      ) : (
        <div className="space-y-2">
          {serverList.map((server) => (
            <McpServerCard
              key={server.config.id}
              server={server}
              isExpanded={expandedServerId === server.config.id}
              onToggleExpand={() => 
                setExpandedServerId(
                  expandedServerId === server.config.id ? null : server.config.id
                )
              }
              onConnect={() => connectServer(server.config.id)}
              onDisconnect={() => disconnectServer(server.config.id)}
              onRemove={() => removeServer(server.config.id)}
            />
          ))}
        </div>
      )}

      {/* Add server dialog */}
      {isAddingServer && (
        <AddServerDialog
          onClose={() => setIsAddingServer(false)}
          onAdd={async (input) => {
            await addServer(input);
            setIsAddingServer(false);
          }}
        />
      )}
    </div>
  );
};

// ============ Server Card ============

interface McpServerCardProps {
  server: McpServer;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}

const McpServerCard: React.FC<McpServerCardProps> = ({
  server,
  isExpanded,
  onToggleExpand,
  onConnect,
  onDisconnect,
  onRemove,
}) => {
  const { t } = useTranslation();
  const { config, status, tools, error } = server;

  const statusConfig = {
    disconnected: { color: 'bg-muted-foreground', label: 'Disconnected' },
    connecting: { color: 'bg-yellow-500 animate-pulse', label: 'Connecting...' },
    connected: { color: 'bg-green-500', label: 'Connected' },
    error: { color: 'bg-destructive', label: 'Error' },
  } as const;

  const { color, label } = statusConfig[status];

  return (
    <div className={cn(
      'border rounded-lg overflow-hidden transition-colors',
      status === 'error' ? 'border-destructive/30' : 'border-border/50'
    )}>
      {/* Header */}
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors"
      >
        <div className={cn('w-2 h-2 rounded-full shrink-0', color)} />
        
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium text-foreground truncate">
            {config.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {label}
            {status === 'connected' && tools.length > 0 && (
              <span className="ml-2">
                • {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
              </span>
            )}
          </p>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {status === 'connected' ? (
            <button
              onClick={onDisconnect}
              className="p-1.5 rounded hover:bg-accent"
              title={t('settings.disconnect', 'Disconnect')}
            >
              <Icon name="pause" size={14} className="text-muted-foreground" />
            </button>
          ) : status !== 'connecting' ? (
            <button
              onClick={onConnect}
              className="p-1.5 rounded hover:bg-accent"
              title={t('settings.connect', 'Connect')}
            >
              <Icon name="play" size={14} className="text-muted-foreground" />
            </button>
          ) : null}
        </div>

        <Icon
          name="chevron-down"
          size={14}
          className={cn(
            'text-muted-foreground shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border/50 px-4 py-3 space-y-3 bg-card/30">
          {/* Error */}
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          {/* Configuration */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-muted-foreground">Transport</p>
              <p className="text-foreground font-mono">{config.transport}</p>
            </div>
            {config.command && (
              <div>
                <p className="text-muted-foreground">Command</p>
                <p className="text-foreground font-mono truncate">{config.command}</p>
              </div>
            )}
            {config.args && config.args.length > 0 && (
              <div className="col-span-2">
                <p className="text-muted-foreground">Arguments</p>
                <p className="text-foreground font-mono truncate">{config.args.join(' ')}</p>
              </div>
            )}
          </div>

          {/* Tools list */}
          {tools.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Available Tools</p>
              <div className="flex flex-wrap gap-1">
                {tools.map((tool) => (
                  <span
                    key={tool.name}
                    className="px-2 py-0.5 bg-accent rounded text-xs font-mono"
                    title={tool.description}
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2 border-t border-border/50">
            <button
              onClick={onRemove}
              className="text-xs text-destructive hover:underline"
            >
              {t('common.remove', 'Remove')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ============ Add Server Dialog ============

interface AddServerDialogProps {
  onClose: () => void;
  onAdd: (input: {
    name: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    autoConnect: boolean;
  }) => Promise<void>;
}

const AddServerDialog: React.FC<AddServerDialogProps> = ({ onClose, onAdd }) => {
  const { t } = useTranslation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [autoConnect, setAutoConnect] = useState(true);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    
    setIsSubmitting(true);
    try {
      await onAdd({
        name: name.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() || undefined : undefined,
        args: transport === 'stdio' && args.trim() 
          ? args.split(' ').filter(Boolean) 
          : undefined,
        url: transport === 'sse' ? url.trim() || undefined : undefined,
        autoConnect,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-md bg-card border border-border rounded-lg shadow-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h4 className="text-sm font-medium">
            {t('settings.addMcpServer', 'Add MCP Server')}
          </h4>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <Icon name="x" size={16} className="text-muted-foreground" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              {t('common.name', 'Name')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm"
              placeholder="My MCP Server"
              required
            />
          </div>

          {/* Transport */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Transport
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTransport('stdio')}
                className={cn(
                  'flex-1 py-2 text-sm rounded-md border transition-colors',
                  transport === 'stdio'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border hover:bg-accent'
                )}
              >
                stdio
              </button>
              <button
                type="button"
                onClick={() => setTransport('sse')}
                className={cn(
                  'flex-1 py-2 text-sm rounded-md border transition-colors',
                  transport === 'sse'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border hover:bg-accent'
                )}
              >
                SSE
              </button>
            </div>
          </div>

          {/* Stdio options */}
          {transport === 'stdio' && (
            <>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Command
                </label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono"
                  placeholder="npx"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Arguments (space-separated)
                </label>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono"
                  placeholder="-y @modelcontextprotocol/server-filesystem /path"
                />
              </div>
            </>
          )}

          {/* SSE options */}
          {transport === 'sse' && (
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                URL
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono"
                placeholder="http://localhost:3000/sse"
              />
            </div>
          )}

          {/* Auto-connect */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoConnect}
              onChange={(e) => setAutoConnect(e.target.checked)}
              className="rounded border-border"
            />
            <span className="text-sm text-foreground">
              {t('settings.autoConnect', 'Auto-connect on startup')}
            </span>
          </label>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              {isSubmitting ? (
                <Icon name="loader" size={14} className="animate-spin" />
              ) : (
                t('common.add', 'Add')
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default McpServerPanel;
