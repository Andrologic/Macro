import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MCPServer, MCPTool } from '../../../types';
import {
  formatMCPEnvForEdit,
  formatMCPArgsForEdit,
  getMCPStatusLabel,
  MCP_STATUS_STYLES,
  normalizeMCPIdentifier,
  parseMCPArgs,
  parseMCPEnv,
  summarizeMCPServerCommand,
} from '../../../services/mcp';
import { cn } from '../../../utils/cn';
import { Icon } from '../../ui/Icon';
import { Input } from '../../ui/Input';
import { Switch } from '../../ui/Switch';
import { notify } from '../../ui/toastService';

interface MCPServersPanelProps {
  servers: MCPServer[];
  searchQuery: string;
  onToggleServer: (serverId: string) => Promise<void> | void;
  onUpsertServer: (server: MCPServer) => Promise<void>;
  onRemoveServer: (serverId: string) => Promise<void>;
  onRefreshServerTools: (serverId: string) => Promise<void>;
  onAuthorizeServer: (serverId: string) => Promise<void>;
  onLogoutServer: (serverId: string) => Promise<void>;
}

interface MCPServerDraft {
  name: string;
  transportType: 'stdio' | 'streamable_http';
  command: string;
  args: string;
  env: string;
  url: string;
  protocolMode: 'auto' | 'legacy' | 'modern';
  oauth: boolean;
  scopes: string;
  oauthClientId: string;
  oauthClientMetadataUrl: string;
  enabled: boolean;
}

const emptyDraft = (): MCPServerDraft => ({
  name: '',
  transportType: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  protocolMode: 'auto',
  oauth: false,
  scopes: '',
  oauthClientId: '',
  oauthClientMetadataUrl: '',
  enabled: true,
});

const MCPDiscoveredTools: React.FC<{ tools?: MCPTool[] }> = ({ tools }) => {
  if (!tools?.length) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pl-11">
      {tools.map((tool) => (
        <span
          key={tool.id}
          className="max-w-full truncate rounded border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          title={tool.description || tool.name}
        >
          {tool.name}
        </span>
      ))}
    </div>
  );
};

const MCPServerForm: React.FC<{
  draft: MCPServerDraft;
  editing: boolean;
  onCancel: () => void;
  onChange: (draft: MCPServerDraft) => void;
  onSave: () => void;
}> = ({ draft, editing, onCancel, onChange, onSave }) => {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-foreground">
            {editing
              ? t('tools.mcp.editServer', 'Edit MCP server')
              : t('tools.mcp.addServer', 'Add MCP server')}
          </h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'tools.mcp.transportHint',
              'Use stdio for local servers or Streamable HTTP for legacy and stateless remote servers.'
            )}
          </p>
        </div>
        {editing && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent"
            title={t('common.cancel', 'Cancel')}
          >
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)]">
        <Input
          placeholder={t('tools.mcp.namePlaceholder', 'Server name')}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
        <select
          value={draft.transportType}
          onChange={(event) =>
            onChange({
              ...draft,
              transportType: event.target.value as MCPServerDraft['transportType'],
            })
          }
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="stdio">{t('tools.mcp.transport.stdio', 'Local stdio')}</option>
          <option value="streamable_http">
            {t('tools.mcp.transport.streamableHttp', 'Streamable HTTP')}
          </option>
        </select>
        {draft.transportType === 'stdio' ? (
          <>
            <Input
              placeholder={t('tools.mcp.commandPlaceholder', 'Command, e.g. npx')}
              value={draft.command}
              onChange={(event) => onChange({ ...draft, command: event.target.value })}
              className="font-mono md:col-span-2"
            />
            <Input
              placeholder={t('tools.mcp.argsPlaceholder', 'Args, e.g. -y @modelcontextprotocol/server-filesystem .')}
              value={draft.args}
              onChange={(event) => onChange({ ...draft, args: event.target.value })}
              className="font-mono md:col-span-2"
            />
            <textarea
              placeholder={t('tools.mcp.envPlaceholder', 'ENV_NAME=value')}
              value={draft.env}
              onChange={(event) => onChange({ ...draft, env: event.target.value })}
              className="min-h-20 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30 md:col-span-2"
            />
          </>
        ) : (
          <>
            <Input
              type="url"
              placeholder={t('tools.mcp.urlPlaceholder', 'https://example.com/mcp')}
              value={draft.url}
              onChange={(event) => onChange({ ...draft, url: event.target.value })}
              className="font-mono md:col-span-2"
            />
            <select
              value={draft.protocolMode}
              onChange={(event) =>
                onChange({
                  ...draft,
                  protocolMode: event.target.value as MCPServerDraft['protocolMode'],
                })
              }
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="auto">{t('tools.mcp.protocol.auto', 'Automatic detection')}</option>
              <option value="legacy">{t('tools.mcp.protocol.legacy', 'Legacy session')}</option>
              <option value="modern">{t('tools.mcp.protocol.modern', 'Modern stateless')}</option>
            </select>
            <label className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
              <Switch
                checked={draft.oauth}
                aria-label={t('tools.mcp.oauth.enable', 'Use OAuth')}
                onCheckedChange={(oauth) => onChange({ ...draft, oauth })}
              />
              {t('tools.mcp.oauth.enable', 'Use OAuth')}
            </label>
            {draft.oauth && (
              <>
                <Input
                  placeholder={t('tools.mcp.oauth.scopes', 'Scopes, separated by spaces')}
                  value={draft.scopes}
                  onChange={(event) => onChange({ ...draft, scopes: event.target.value })}
                  className="font-mono md:col-span-2"
                />
                <Input
                  placeholder={t('tools.mcp.oauth.clientId', 'Optional pre-registered client ID')}
                  value={draft.oauthClientId}
                  onChange={(event) =>
                    onChange({ ...draft, oauthClientId: event.target.value })
                  }
                  className="font-mono"
                />
                <Input
                  type="url"
                  placeholder={t(
                    'tools.mcp.oauth.clientMetadataUrl',
                    'Optional HTTPS client metadata URL'
                  )}
                  value={draft.oauthClientMetadataUrl}
                  onChange={(event) =>
                    onChange({ ...draft, oauthClientMetadataUrl: event.target.value })
                  }
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground md:col-span-2">
                  {t(
                    'tools.mcp.oauth.registrationHint',
                    'Use either a client ID or a client metadata URL. Leave both empty only for servers that support dynamic client registration.'
                  )}
                </p>
              </>
            )}
          </>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={draft.enabled}
            aria-label={t('tools.mcp.enableServer', 'Enable server')}
            onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
          />
          {t('tools.mcp.enableServer', 'Enable server')}
        </label>
        <button
          type="button"
          onClick={onSave}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Icon name="save" size={15} />
          {editing ? t('common.save', 'Save') : t('common.add', 'Add')}
        </button>
      </div>
    </div>
  );
};

const MCPServerRow: React.FC<{
  server: MCPServer;
  onEdit: (server: MCPServer) => void;
  onDelete: (serverId: string) => void;
  onRefresh: (serverId: string) => void;
  onToggle: (serverId: string) => void;
  onAuthorize: (serverId: string) => void;
  onLogout: (serverId: string) => void;
}> = ({ server, onEdit, onDelete, onRefresh, onToggle, onAuthorize, onLogout }) => {
  const { t } = useTranslation();
  const enabled = server.config?.enabled === true;
  const toolCount = server.tools?.length ?? 0;

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 h-fit rounded-md bg-primary/10 p-2 text-primary">
            <Icon name="server" size={17} />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <h4 className="truncate text-sm font-medium text-foreground">{server.name}</h4>
              <span
                className={cn(
                  'shrink-0 rounded-full border px-2 py-0.5 text-[11px]',
                  MCP_STATUS_STYLES[server.status]
                )}
              >
                {t(`tools.mcp.status.${server.status}`, getMCPStatusLabel(server.status))}
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground" title={summarizeMCPServerCommand(server)}>
              {summarizeMCPServerCommand(server)}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t('tools.mcp.toolCount', '{{count}} tools', { count: toolCount })}</span>
              {server.discoveredAt && (
                <span>
                  {t('tools.mcp.discoveredAt', 'Discovered {{time}}', {
                    time: new Date(server.discoveredAt).toLocaleTimeString(),
                  })}
                </span>
              )}
            </div>
            {server.lastError && (
              <p className="max-w-2xl truncate text-xs text-red-500" title={server.lastError}>
                {server.lastError}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={enabled}
            aria-label={t('tools.mcp.enableServer', 'Enable server')}
            onCheckedChange={() => onToggle(server.id)}
          />
          {server.authorization?.type === 'oauth' && (
            <>
              <button
                type="button"
                onClick={() => onAuthorize(server.id)}
                className="rounded-md px-2 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
                title={t('tools.mcp.oauth.authorizeHint', 'Authorize this MCP server')}
              >
                {t('tools.mcp.oauth.authorize', 'Connect')}
              </button>
              <button
                type="button"
                onClick={() => onLogout(server.id)}
                className="rounded-md p-2 text-muted-foreground hover:bg-accent"
                title={t('tools.mcp.oauth.logout', 'Remove OAuth authorization')}
              >
                <Icon name="unlock" size={15} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onRefresh(server.id)}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent"
            title={t('tools.mcp.refreshTools', 'Refresh tools')}
          >
            <Icon name="refresh-cw" size={15} />
          </button>
          <button
            type="button"
            onClick={() => onEdit(server)}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent"
            title={t('common.edit', 'Edit')}
          >
            <Icon name="edit" size={15} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(server.id)}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent"
            title={t('common.delete', 'Delete')}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </div>

      <MCPDiscoveredTools tools={server.tools} />
    </div>
  );
};

const MCPServerList: React.FC<{
  servers: MCPServer[];
  onEdit: (server: MCPServer) => void;
  onDelete: (serverId: string) => void;
  onRefresh: (serverId: string) => void;
  onToggle: (serverId: string) => void;
  onAuthorize: (serverId: string) => void;
  onLogout: (serverId: string) => void;
}> = ({ servers, onEdit, onDelete, onRefresh, onToggle, onAuthorize, onLogout }) => {
  const { t } = useTranslation();

  if (servers.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-muted-foreground">
          {t('tools.noCustomMcpServers', 'No custom MCP servers configured.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {servers.map((server) => (
        <MCPServerRow
          key={server.id}
          server={server}
          onEdit={onEdit}
          onDelete={onDelete}
          onRefresh={onRefresh}
          onToggle={onToggle}
          onAuthorize={onAuthorize}
          onLogout={onLogout}
        />
      ))}
    </div>
  );
};

export const MCPServersPanel: React.FC<MCPServersPanelProps> = ({
  servers,
  searchQuery,
  onToggleServer,
  onUpsertServer,
  onRemoveServer,
  onRefreshServerTools,
  onAuthorizeServer,
  onLogoutServer,
}) => {
  const { t } = useTranslation();
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MCPServerDraft>(emptyDraft);

  const filteredServers = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return servers.filter(
      (server) =>
        server.name.toLowerCase().includes(query) ||
        (server.website && server.website.toLowerCase().includes(query))
    );
  }, [servers, searchQuery]);

  const resetDraft = () => {
    setEditingServerId(null);
    setDraft(emptyDraft());
  };

  const beginEditServer = (server: MCPServer) => {
    setEditingServerId(server.id);
    setDraft({
      name: server.name,
      transportType: server.transport?.type === 'streamable_http' ? 'streamable_http' : 'stdio',
      command: server.transport?.type === 'stdio' ? server.transport.command : '',
      args:
        server.transport?.type === 'stdio' && server.transport.args
          ? formatMCPArgsForEdit(server.transport.args)
          : '',
      env:
        server.transport?.type === 'stdio' && server.transport.env
          ? formatMCPEnvForEdit(server.transport.env)
          : '',
      url: server.transport?.type === 'streamable_http' ? server.transport.url : '',
      protocolMode: server.protocol?.mode ?? 'auto',
      oauth: server.authorization?.type === 'oauth',
      scopes:
        server.authorization?.type === 'oauth'
          ? (server.authorization.scopes ?? []).join(' ')
          : '',
      oauthClientId:
        server.authorization?.type === 'oauth' ? server.authorization.clientId ?? '' : '',
      oauthClientMetadataUrl:
        server.authorization?.type === 'oauth'
          ? server.authorization.clientMetadataUrl ?? ''
          : '',
      enabled: server.config?.enabled === true,
    });
  };

  const saveDraft = async () => {
    const name = draft.name.trim();
    const command = draft.command.trim();
    const url = draft.url.trim();
    const oauthClientId = draft.oauthClientId.trim();
    const oauthClientMetadataUrl = draft.oauthClientMetadataUrl.trim();
    if (!name || (draft.transportType === 'stdio' ? !command : !url)) {
      notify.error(
        t('tools.mcp.validationFailed', 'A name and a valid transport endpoint are required.')
      );
      return;
    }
    if (draft.oauth && oauthClientId && oauthClientMetadataUrl) {
      notify.error(
        t(
          'tools.mcp.oauth.clientIdentityConflict',
          'Use either an OAuth client ID or a client metadata URL, not both.'
        )
      );
      return;
    }

    const existing = editingServerId
      ? servers.find((server) => server.id === editingServerId)
      : null;
    const id = existing?.id ?? normalizeMCPIdentifier(name);
    if (!existing && servers.some((server) => normalizeMCPIdentifier(server.id) === id)) {
      notify.error(
        t(
          'tools.mcp.identifierCollision',
          'Another MCP server already uses this normalized identifier. Choose a different name.'
        )
      );
      return;
    }
    const previousEnv =
      existing?.transport?.type === 'stdio' ? existing.transport.env ?? {} : {};
    const server: MCPServer = {
      ...(existing ?? {
        id,
        category: 'development',
        description:
          draft.transportType === 'stdio'
            ? 'Custom MCP stdio server'
            : 'Custom MCP Streamable HTTP server',
        icon: 'server',
        status: 'offline',
      }),
      id,
      name,
      transport:
        draft.transportType === 'stdio'
          ? {
              type: 'stdio',
              command,
              args: parseMCPArgs(draft.args),
              env: parseMCPEnv(draft.env, previousEnv),
            }
          : {
              ...(existing?.transport?.type === 'streamable_http' ? existing.transport : {}),
              type: 'streamable_http',
              url,
            },
      protocol:
        draft.transportType === 'streamable_http'
          ? { ...(existing?.protocol ?? {}), mode: draft.protocolMode }
          : undefined,
      authorization:
        draft.transportType === 'streamable_http' && draft.oauth
          ? {
              type: 'oauth',
              scopes: Array.from(
                new Set(
                  draft.scopes
                    .split(/[\s,]+/)
                    .map((scope) => scope.trim())
                    .filter(Boolean)
                  )
              ),
              ...(oauthClientId ? { clientId: oauthClientId } : {}),
              ...(oauthClientMetadataUrl ? { clientMetadataUrl: oauthClientMetadataUrl } : {}),
              ...(oauthClientId &&
              existing?.authorization?.type === 'oauth' &&
              existing.authorization.clientId === oauthClientId &&
              existing.authorization.clientSecretRef
                ? { clientSecretRef: existing.authorization.clientSecretRef }
                : {}),
            }
          : undefined,
      status: existing?.status === 'online' ? 'offline' : existing?.status ?? 'offline',
      lastError: null,
      config: {
        ...(existing?.config ?? {}),
        enabled: draft.enabled,
      },
    };

    try {
      await onUpsertServer(server);
      notify.success(
        editingServerId
          ? t('tools.mcp.serverUpdated', 'MCP server updated.')
          : t('tools.mcp.serverAdded', 'MCP server added.')
      );
      resetDraft();
    } catch (error) {
      notify.error(t('tools.mcp.saveFailed', 'Failed to save MCP server.'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const refreshServer = async (serverId: string) => {
    try {
      await onRefreshServerTools(serverId);
      notify.success(t('tools.mcp.toolsRefreshed', 'MCP tools refreshed.'));
    } catch (error) {
      notify.error(t('tools.mcp.refreshFailed', 'Failed to refresh MCP tools.'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const deleteServer = async (serverId: string) => {
    try {
      await onRemoveServer(serverId);
      if (editingServerId === serverId) resetDraft();
      notify.success(t('tools.mcp.serverDeleted', 'MCP server deleted.'));
    } catch (error) {
      notify.error(t('tools.mcp.deleteFailed', 'Failed to delete MCP server.'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const toggleServer = async (serverId: string) => {
    try {
      await onToggleServer(serverId);
    } catch (error) {
      notify.error(t('tools.mcp.toggleFailed', 'Failed to update MCP server.'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const authorizeServer = async (serverId: string) => {
    try {
      await onAuthorizeServer(serverId);
      notify.success(t('tools.mcp.oauth.authorized', 'MCP server authorized and connected.'));
    } catch (error) {
      notify.error(t('tools.mcp.oauth.failed', 'MCP authorization failed.'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const logoutServer = async (serverId: string) => {
    try {
      await onLogoutServer(serverId);
      notify.success(t('tools.mcp.oauth.loggedOut', 'MCP authorization removed.'));
    } catch (error) {
      notify.error(t('tools.mcp.oauth.logoutFailed', 'Failed to remove MCP authorization.'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="space-y-3">
      <MCPServerForm
        draft={draft}
        editing={Boolean(editingServerId)}
        onCancel={resetDraft}
        onChange={setDraft}
        onSave={() => void saveDraft()}
      />
      <MCPServerList
        servers={filteredServers}
        onEdit={beginEditServer}
        onDelete={(serverId) => void deleteServer(serverId)}
        onRefresh={(serverId) => void refreshServer(serverId)}
        onToggle={(serverId) => void toggleServer(serverId)}
        onAuthorize={(serverId) => void authorizeServer(serverId)}
        onLogout={(serverId) => void logoutServer(serverId)}
      />
    </div>
  );
};
