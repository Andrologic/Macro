import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToolsStore } from '../../../stores/useToolsStore';
import { Icon } from '../../ui/Icon';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/Tabs';
import { Input } from '../../ui/Input';
import { Switch } from '../../ui/Switch';
import { cn } from '../../../utils/cn';
import { useAppStore } from '../../../stores/useAppStore';
import { useProviderStore } from '../../../stores/useProviderStore';
import { getToolModePolicy } from '../../../services/toolModePolicy';
import { loadPreference, PREF_KEYS } from '../../../services/preferences';
import type { ToolRiskLevel } from '../../../types';
import {
  DEFAULT_TOOL_RISK_LEVEL,
  filterDeniedToolIdsForRiskLevel,
} from '../../../services/toolSecurityPolicy';
import {
  getWebSearchSettings,
  refreshWebSearchSettings,
  saveWebSearchSettings,
  setWebSearchApiKey,
} from '../../../services/webSearchSettings';
import type { WebSearchSettings } from '../../../services/webSearchSettings';
import { MCPServersPanel } from '../mcp/MCPServersPanel';
import {
  SettingsCollectionHeader,
  SettingsSearchEmpty,
  useSettingsSearch,
} from '../search/SettingsSearch';

export const ToolsView: React.FC = () => {
  const { t } = useTranslation();
  const {
    internalTools,
    mcpServers,
    loadSettings,
    toggleTool,
    toggleMCPServer,
    upsertMCPServer,
    removeMCPServer,
    refreshMCPServerTools,
    authorizeMCPServer,
    logoutMCPServer,
    storeMCPOAuthClientSecret,
    deleteMCPOAuthClientSecret,
    isToolEnabled,
  } = useToolsStore();
  const mode = useAppStore((state) => state.mode);
  const nativeToolsSupported = useProviderStore((state) =>
    state.selectedSupportsNativeToolCalling()
  );
  const [toolRiskLevel, setToolRiskLevel] =
    useState<ToolRiskLevel>(DEFAULT_TOOL_RISK_LEVEL);

  const chatPolicy = useMemo(
    () => ({
      ...getToolModePolicy('Chat'),
      allowedToolIds: filterDeniedToolIdsForRiskLevel(
        getToolModePolicy('Chat').allowedToolIds,
        toolRiskLevel,
        'Chat'
      ),
    }),
    [toolRiskLevel]
  );
  const architectPolicy = useMemo(
    () => ({
      ...getToolModePolicy('Architect'),
      allowedToolIds: filterDeniedToolIdsForRiskLevel(
        getToolModePolicy('Architect').allowedToolIds,
        toolRiskLevel,
        'Architect'
      ),
    }),
    [toolRiskLevel]
  );
  const implementPolicy = useMemo(
    () => ({
      ...getToolModePolicy('Implement'),
      allowedToolIds: filterDeniedToolIdsForRiskLevel(
        getToolModePolicy('Implement').allowedToolIds,
        toolRiskLevel,
        'Implement'
      ),
    }),
    [toolRiskLevel]
  );

  const { query, setQuery, matches } = useSettingsSearch();
  const [activeToolsTab, setActiveToolsTab] = useState('websearch');
  const [webSearchSettings, setWebSearchSettings] = useState<WebSearchSettings>(getWebSearchSettings);
  const [webSearchSecretDraft, setWebSearchSecretDraft] = useState('');
  const hasSelectedWebSearchKey = useMemo(() => {
    if (webSearchSettings.provider === 'tavily') {
      return webSearchSettings.hasTavilySecret;
    }
    return webSearchSettings.hasBraveSecret;
  }, [webSearchSettings]);

  useEffect(() => {
    loadSettings();
    void refreshWebSearchSettings().then(setWebSearchSettings);
  }, [loadSettings]);

  useEffect(() => {
    let cancelled = false;

    void loadPreference<ToolRiskLevel>(PREF_KEYS.TOOL_RISK_LEVEL).then((profile) => {
      if (!cancelled) {
        setToolRiskLevel(profile);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateWebSearchSettings = async (updates: Partial<WebSearchSettings>) => {
    const provider = updates.provider ?? webSearchSettings.provider;
    const providerHasSecret = provider === 'tavily'
      ? webSearchSettings.hasTavilySecret
      : webSearchSettings.hasBraveSecret;
    const nextSettings = {
      ...webSearchSettings,
      ...updates,
      secretRef: providerHasSecret ? `macro-secret://web-search/${provider}` : null,
    };
    setWebSearchSettings(nextSettings);
    setWebSearchSettings(await saveWebSearchSettings(nextSettings));
  };

  const commitWebSearchSecret = async () => {
    const value = webSearchSecretDraft.trim();
    if (!value) return;
    const next = await setWebSearchApiKey(webSearchSettings.provider, value);
    setWebSearchSettings(next);
    setWebSearchSecretDraft('');
  };

  const deleteWebSearchSecret = async () => {
    const next = await setWebSearchApiKey(webSearchSettings.provider, null);
    setWebSearchSettings(next);
    setWebSearchSecretDraft('');
  };

  const filteredTools = useMemo(
    () => Object.values(internalTools).filter(
      (tool) => tool.config?.visible !== false && matches(tool.name, tool.description, tool.category)
    ),
    [internalTools, matches]
  );
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

      <Tabs
        defaultValue="websearch"
        value={activeToolsTab}
        onValueChange={(nextTab) => {
          setActiveToolsTab(nextTab);
          setQuery('');
        }}
        className="flex-1 flex flex-col overflow-hidden"
      >
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
                    onClick={() => void updateWebSearchSettings({ provider: 'tavily' })}
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
                    onClick={() => void updateWebSearchSettings({ provider: 'brave' })}
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
                    value={webSearchSecretDraft}
                    onChange={(event) => setWebSearchSecretDraft(event.target.value)}
                    onBlur={() => void commitWebSearchSecret()}
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
                    value={webSearchSecretDraft}
                    onChange={(event) => setWebSearchSecretDraft(event.target.value)}
                    onBlur={() => void commitWebSearchSecret()}
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
                {hasSelectedWebSearchKey && (
                  <button
                    type="button"
                    className="ml-auto text-destructive hover:underline"
                    onClick={() => void deleteWebSearchSecret()}
                  >
                    {t('common.delete', 'Delete')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="tools" className="flex-1 overflow-y-auto pr-2 space-y-3">
          <SettingsCollectionHeader
            title={t('tools.builtInTools', 'Built-in tools')}
            description={t(
              'tools.builtInToolsDescription',
              'Control which tools models can use'
            )}
            searchPlaceholder={t('tools.searchBuiltInTools', 'Search tools...')}
            className="pb-1"
          />
          {filteredTools.map((tool) => {
            const webSearchLockedByKey = tool.id === 'web_search' && !hasSelectedWebSearchKey;
            const switchDisabled = webSearchLockedByKey;

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
                    <Icon name={tool.icon || 'tool'} size={18} />
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
                  checked={webSearchLockedByKey ? false : isToolEnabled(tool.id)}
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

              </div>
            );
          })}

          {filteredTools.length === 0 && (
            query.trim()
              ? <SettingsSearchEmpty message={t('tools.noToolsFound', 'No tools found')} />
              : (
                <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                  {t('tools.noToolsFound', 'No tools found')}
                </div>
              )
          )}
        </TabsContent>

        <TabsContent value="mcp" className="flex-1 overflow-y-auto pr-2 space-y-3">
          <MCPServersPanel
            servers={mcpServers}
            searchQuery={query}
            onToggleServer={toggleMCPServer}
            onUpsertServer={upsertMCPServer}
            onRemoveServer={removeMCPServer}
            onRefreshServerTools={refreshMCPServerTools}
            onAuthorizeServer={authorizeMCPServer}
            onLogoutServer={logoutMCPServer}
            onStoreOAuthClientSecret={storeMCPOAuthClientSecret}
            onDeleteOAuthClientSecret={deleteMCPOAuthClientSecret}
          />
        </TabsContent>
      </Tabs>

    </div>
  );
};
