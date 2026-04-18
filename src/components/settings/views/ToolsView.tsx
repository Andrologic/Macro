import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToolsStore } from '../../../stores/useToolsStore';
import { Icon } from '../../ui/Icon';
// @ts-ignore
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/Tabs';
import { Input } from '../../ui/Input';
import { Switch } from '../../ui/Switch';
import { cn } from '../../../utils/cn';
import { useAppStore } from '../../../stores/useAppStore';
import { useProviderStore } from '../../../stores/useProviderStore';
import { getToolModePolicy } from '../../../services/toolModePolicy';
import {
  DEFAULT_ARCHITECT_TOOL_AUTONOMY_PROFILE,
  isArchitectDestructiveChatToolId,
  type ArchitectToolAutonomyProfile,
} from '../../../services/architectToolSurface';
import {
  loadPreference,
  PREF_KEYS,
  savePreference,
} from '../../../services/preferences';
import {
  WebSearchSettings,
  getWebSearchSettings,
  saveWebSearchSettings,
} from '../../../services/webSearchSettings';

export const ToolsView: React.FC = () => {
  const { t } = useTranslation();
  const {
    internalTools,
    mcpServers,
    loadSettings,
    toggleTool,
    toggleMCPServer,
    isToolEnabled,
  } = useToolsStore();
  const mode = useAppStore((state) => state.mode);
  const nativeToolsSupported = useProviderStore((state) =>
    state.selectedSupportsNativeToolCalling()
  );
  const [architectToolAutonomyProfile, setArchitectToolAutonomyProfile] =
    useState<ArchitectToolAutonomyProfile>(DEFAULT_ARCHITECT_TOOL_AUTONOMY_PROFILE);

  const chatPolicy = useMemo(() => getToolModePolicy('Chat'), []);
  const architectPolicy = useMemo(
    () =>
      getToolModePolicy('Architect', {
        architectToolAutonomyProfile,
      }),
    [architectToolAutonomyProfile]
  );
  const implementPolicy = useMemo(() => getToolModePolicy('Implement'), []);

  const [searchQuery, setSearchQuery] = useState('');
  const [webSearchSettings, setWebSearchSettings] = useState<WebSearchSettings>(getWebSearchSettings);
  const hasSelectedWebSearchKey = useMemo(() => {
    if (webSearchSettings.provider === 'tavily') {
      return webSearchSettings.tavilyApiKey.trim().length > 0;
    }
    return webSearchSettings.braveApiKey.trim().length > 0;
  }, [webSearchSettings]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    let cancelled = false;

    void loadPreference<ArchitectToolAutonomyProfile>(
      PREF_KEYS.ARCHITECT_TOOL_AUTONOMY_PROFILE
    ).then((profile) => {
      if (!cancelled) {
        setArchitectToolAutonomyProfile(profile);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateWebSearchSettings = (updates: Partial<WebSearchSettings>) => {
    const nextSettings = { ...webSearchSettings, ...updates };
    setWebSearchSettings(nextSettings);
    saveWebSearchSettings(nextSettings);
  };

  const updateArchitectToolAutonomyProfile = (
    profile: ArchitectToolAutonomyProfile
  ) => {
    setArchitectToolAutonomyProfile(profile);
    void savePreference(PREF_KEYS.ARCHITECT_TOOL_AUTONOMY_PROFILE, profile);
  };

  const filteredTools = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return Object.values(internalTools).filter(
      (tool) =>
        tool.config?.visible !== false &&
        (tool.name.toLowerCase().includes(query) || tool.description.toLowerCase().includes(query))
    );
  }, [internalTools, searchQuery]);

  const filteredServers = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return mcpServers.filter(
      (server) =>
        server.name.toLowerCase().includes(query) ||
        (server.website && server.website.toLowerCase().includes(query))
    );
  }, [mcpServers, searchQuery]);

  const modeHint =
    mode === 'Chat'
      ? t(
          'tools.modeHintChat',
          'Chat mode: user-selected tools from the Chat toolbox are respected before execution.'
        )
      : t(
            'tools.modeHintAuto',
            'Architect/Implement: enabled tools may run automatically when the model needs them; usage is shown inline in chat.'
          );

  return (
    <div className="h-full flex flex-col animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        {modeHint}
      </div>

      {!nativeToolsSupported && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {t(
            'tools.nativeToolSupportWarning',
            'The currently selected provider or model does not support native tool calling. Tools remain configurable here, but they will not be injected until a compatible model is selected.'
          )}
        </div>
      )}

      <div className="mb-6">
        <Input
          placeholder={t('tools.searchPlaceholder', 'Search tools & servers...')}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="max-w-md"
        />
      </div>

      <Tabs defaultValue="websearch" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="mb-4">
          <TabsTrigger value="websearch" className="flex items-center gap-2">
            <Icon name="search" size={14} />
            {t('tools.tabs.webSearch', 'Web Search')}
          </TabsTrigger>
          <TabsTrigger value="tools" className="flex items-center gap-2">
            <Icon name="tool" size={14} />
            {t('tools.tabs.builtInTools', 'Built-in Tools')}
          </TabsTrigger>
          <TabsTrigger value="mcp" className="flex items-center gap-2">
            <Icon name="server" size={14} />
            {t('tools.tabs.mcpServers', 'MCP Servers')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="websearch" className="flex-1 overflow-y-auto pr-2 space-y-4">
          <div className="p-4 bg-card border border-border rounded-xl">
            <div className="flex items-start justify-between mb-4">
              <div className="flex gap-4">
                <div className="p-2 bg-primary/10 rounded-lg text-primary h-fit">
                  <Icon name="globe" size={18} />
                </div>
                <div className="space-y-1">
                  <h4 className="font-medium text-foreground">
                    {t('tools.webSearch.title', 'Web Search')}
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'tools.webSearch.description',
                      'Enable AI to search the web for up-to-date information with citations.'
                    )}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4 pt-4 border-t border-border">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  {t('tools.webSearch.providerLabel', 'Search Provider')}
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => updateWebSearchSettings({ provider: 'tavily' })}
                    className={cn(
                      'flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors',
                      webSearchSettings.provider === 'tavily'
                        ? 'bg-primary/10 border-primary text-primary'
                        : 'bg-card border-border text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {t('tools.webSearch.tavilyRecommended', 'Tavily (Recommended)')}
                  </button>
                  <button
                    onClick={() => updateWebSearchSettings({ provider: 'brave' })}
                    className={cn(
                      'flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors',
                      webSearchSettings.provider === 'brave'
                        ? 'bg-primary/10 border-primary text-primary'
                        : 'bg-card border-border text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {t('tools.webSearch.braveSearch', 'Brave Search')}
                  </button>
                </div>
              </div>

              {webSearchSettings.provider === 'tavily' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    {t('tools.webSearch.tavilyApiKey', 'Tavily API Key')}
                  </label>
                  <Input
                    type="password"
                    placeholder="tvly-xxxxxxxxxxxxxxxx"
                    value={webSearchSettings.tavilyApiKey}
                    onChange={(event) =>
                      updateWebSearchSettings({ tavilyApiKey: event.target.value })
                    }
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('tools.webSearch.getApiKeyAt', 'Get your API key at')}{' '}
                    <a
                      href="https://tavily.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      tavily.com
                    </a>{' '}
                    ({t('tools.webSearch.tavilyFreeTier', '1000 free searches/month')})
                  </p>
                </div>
              )}

              {webSearchSettings.provider === 'brave' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    {t('tools.webSearch.braveApiKey', 'Brave Search API Key')}
                  </label>
                  <Input
                    type="password"
                    placeholder="BSAxxxxxxxxxxxxxxxx"
                    value={webSearchSettings.braveApiKey}
                    onChange={(event) =>
                      updateWebSearchSettings({ braveApiKey: event.target.value })
                    }
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('tools.webSearch.getApiKeyAt', 'Get your API key at')}{' '}
                    <a
                      href="https://brave.com/search/api/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      brave.com/search/api
                    </a>{' '}
                    ({t('tools.webSearch.braveFreeTier', '2000 free searches/month')})
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2 text-xs pt-2">
                <span
                  className={cn(
                    'w-2 h-2 rounded-full',
                    hasSelectedWebSearchKey ? 'bg-emerald-500' : 'bg-amber-500'
                  )}
                />
                <span className="text-muted-foreground">
                  {hasSelectedWebSearchKey
                    ? t('tools.webSearch.configured', 'Configured')
                    : t(
                        'tools.webSearch.apiKeyRequired',
                        'API key required to enable Web Search'
                      )}
                </span>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="tools" className="flex-1 overflow-y-auto pr-2 space-y-3">
          <div className="p-4 bg-card border border-border rounded-xl">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h4 className="font-medium text-foreground">
                  {t('tools.architectAutonomy.title', 'Architect Tool Autonomy')}
                </h4>
                <p className="text-sm text-muted-foreground">
                  {t(
                    'tools.architectAutonomy.description',
                    'Choose whether Architect chat can use destructive need and strategy deletion tools.'
                  )}
                </p>
              </div>
              <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground uppercase">
                {architectToolAutonomyProfile}
              </span>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => updateArchitectToolAutonomyProfile('guarded')}
                className={cn(
                  'flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors',
                  architectToolAutonomyProfile === 'guarded'
                    ? 'bg-primary/10 border-primary text-primary'
                    : 'bg-card border-border text-muted-foreground hover:bg-accent'
                )}
              >
                {t('tools.architectAutonomy.guarded', 'Guarded')}
              </button>
              <button
                onClick={() => updateArchitectToolAutonomyProfile('full')}
                className={cn(
                  'flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors',
                  architectToolAutonomyProfile === 'full'
                    ? 'bg-primary/10 border-primary text-primary'
                    : 'bg-card border-border text-muted-foreground hover:bg-accent'
                )}
              >
                {t('tools.architectAutonomy.full', 'Full')}
              </button>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              {architectToolAutonomyProfile === 'guarded'
                ? t(
                    'tools.architectAutonomy.guardedHint',
                    'Guarded keeps need and strategy deletions unavailable to the model.'
                  )
                : t(
                    'tools.architectAutonomy.fullHint',
                    'Full also exposes need_delete and strategy_delete, but both still require confirm=true.'
                  )}
            </p>
          </div>

          {filteredTools.map((tool) => {
            const webSearchLockedByKey = tool.id === 'web_search' && !hasSelectedWebSearchKey;
            const switchDisabled = webSearchLockedByKey || !nativeToolsSupported;

            return (
              <div
                key={tool.id}
                className={cn(
                  'relative group flex items-start justify-between p-4 bg-card border border-border rounded-xl',
                  switchDisabled && 'cursor-help'
                )}
              >
                <div className={cn('flex gap-4', switchDisabled && 'opacity-50')}>
                  <div className="p-2 bg-primary/10 rounded-lg text-primary h-fit">
                    <Icon name={(tool.icon as any) || 'tool'} size={18} />
                  </div>
                  <div className="space-y-1">
                    <h4 className="font-medium text-foreground">{tool.name}</h4>
                    <p className="text-sm text-muted-foreground">{tool.description}</p>
                    <div className="flex gap-2 flex-wrap">
                      <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground capitalize">
                        {tool.category}
                      </span>
                      {chatPolicy.allowedToolIds.includes(tool.id) && (
                        <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">
                          {t('header.chat', 'Chat')}
                        </span>
                      )}
                      {architectPolicy.allowedToolIds.includes(tool.id) && (
                        <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">
                          {t('header.architect', 'Architect')}
                        </span>
                      )}
                      {!architectPolicy.allowedToolIds.includes(tool.id) &&
                        isArchitectDestructiveChatToolId(tool.id) &&
                        architectToolAutonomyProfile === 'guarded' && (
                          <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">
                            {t('tools.architectFullOnly', 'Architect Full')}
                          </span>
                        )}
                      {implementPolicy.allowedToolIds.includes(tool.id) && (
                        <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">
                          {t('header.implement', 'Implement')}
                        </span>
                      )}
                      {(tool.id === 'write' || tool.id === 'edit') && (
                        <span className="text-xs bg-amber-500/10 px-2 py-0.5 rounded text-amber-600 dark:text-amber-400">
                          {t('tools.architectMacroOnly', 'Architect: @macro only')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <Switch
                  checked={isToolEnabled(tool.id)}
                  disabled={switchDisabled}
                  onCheckedChange={() => {
                    if (switchDisabled) return;
                    void toggleTool(tool.id);
                  }}
                  className={cn(switchDisabled && 'opacity-50')}
                  id={tool.id}
                />

                {webSearchLockedByKey && (
                  <div className="pointer-events-none absolute -top-2 right-3 hidden group-hover:block z-10">
                    <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-md whitespace-nowrap">
                      {t(
                        'tools.webSearch.enableTooltipNeedKey',
                        'Add an API key in Web Search settings to enable this tool.'
                      )}
                    </div>
                  </div>
                )}

                {!webSearchLockedByKey && !nativeToolsSupported && (
                  <div className="pointer-events-none absolute -top-2 right-3 hidden group-hover:block z-10">
                    <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-md whitespace-nowrap">
                      {t(
                        'tools.needNativeToolSupportTooltip',
                        'Select a model with native tool calling support to use this tool.'
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {filteredTools.length === 0 && (
            <p className="text-center text-muted-foreground py-8">
              {t('tools.noToolsFound', 'No tools found.')}
            </p>
          )}
        </TabsContent>

        <TabsContent value="mcp" className="flex-1 overflow-y-auto pr-2 space-y-3">
          {filteredServers.map((server) => (
            <div
              key={server.id}
              className="flex items-start justify-between p-4 bg-card border border-border rounded-xl"
            >
              <div className="flex gap-4">
                <div className="p-2 bg-blue-500/10 rounded-lg text-blue-500 h-fit">
                  <Icon name="database" size={18} />
                </div>
                <div className="space-y-1">
                  <h4 className="font-medium text-foreground">{server.name}</h4>
                  <p className="text-sm text-muted-foreground">
                    {server.website || server.description}
                  </p>
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={cn(
                        'w-2 h-2 rounded-full',
                        server.status === 'online' ? 'bg-emerald-500' : 'bg-red-500'
                      )}
                    />
                    <span className="text-muted-foreground capitalize">
                      {server.status === 'online'
                        ? t('common.online', 'Online')
                        : t('common.offline', 'Offline')}
                    </span>
                  </div>
                </div>
              </div>
              <Switch
                checked={server.status === 'online'}
                onCheckedChange={() => toggleMCPServer(server.id)}
              />
            </div>
          ))}

          {filteredServers.length === 0 && (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {t('tools.noCustomMcpServers', 'No custom MCP servers configured.')}
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
};
