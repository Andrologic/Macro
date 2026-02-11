import React, { useState, useMemo, useEffect } from 'react';
import { useToolsStore } from '../../../stores/useToolsStore';
import { Icon } from '../../ui/Icon';
// @ts-ignore
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/Tabs';
import { Input } from '../../ui/Input';
import { Switch } from '../../ui/Switch';
import { cn } from '../../../utils/cn';

// Web search settings stored in localStorage
const WEB_SEARCH_SETTINGS_KEY = 'macro_web_search_settings';

interface WebSearchSettings {
  tavilyApiKey: string;
  braveApiKey: string;
  provider: 'tavily' | 'brave';
  enabled: boolean;
}

const getWebSearchSettings = (): WebSearchSettings => {
  try {
    const saved = localStorage.getItem(WEB_SEARCH_SETTINGS_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load web search settings', e);
  }
  return { tavilyApiKey: '', braveApiKey: '', provider: 'tavily', enabled: true };
};

const saveWebSearchSettings = (settings: WebSearchSettings) => {
  localStorage.setItem(WEB_SEARCH_SETTINGS_KEY, JSON.stringify(settings));
};

export const ToolsView: React.FC = () => {
    const {
        internalTools,
        mcpServers,
        loadSettings,
        toggleTool,
        toggleMCPServer,
        isToolEnabled,
    } = useToolsStore();

    const [searchQuery, setSearchQuery] = useState('');
    const [webSearchSettings, setWebSearchSettings] = useState<WebSearchSettings>(getWebSearchSettings);

    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    const updateWebSearchSettings = (updates: Partial<WebSearchSettings>) => {
      const newSettings = { ...webSearchSettings, ...updates };
      setWebSearchSettings(newSettings);
      saveWebSearchSettings(newSettings);
    };

    const filteredTools = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return Object.values(internalTools).filter(
            (t) =>
                t.config?.visible !== false &&
                (t.name.toLowerCase().includes(query) ||
                t.description.toLowerCase().includes(query))
        );
    }, [internalTools, searchQuery]);

    const filteredServers = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return mcpServers.filter(
            (s) => 
                s.name.toLowerCase().includes(query) || 
                (s.website && s.website.toLowerCase().includes(query))
        );
    }, [mcpServers, searchQuery]);

    return (
        <div className="h-full flex flex-col animate-in fade-in slide-in-from-bottom-2 duration-300">
             <div className="mb-6">
                <Input 
                   placeholder="Search tools & servers..." 
                   value={searchQuery}
                   onChange={(e) => setSearchQuery(e.target.value)}
                   className="max-w-md"
               />
             </div>

            <Tabs defaultValue="websearch" className="flex-1 flex flex-col overflow-hidden">
                <TabsList className="mb-4">
                    <TabsTrigger value="websearch" className="flex items-center gap-2">
                        <Icon name="search" size={14} />
                        Web Search
                    </TabsTrigger>
                    <TabsTrigger value="tools" className="flex items-center gap-2">
                        <Icon name="tool" size={14} />
                        Built-in Tools
                    </TabsTrigger>
                    <TabsTrigger value="mcp" className="flex items-center gap-2">
                        <Icon name="server" size={14} />
                        MCP Servers
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="websearch" className="flex-1 overflow-y-auto pr-2 space-y-4">
                    {/* Web Search Configuration */}
                    <div className="p-4 bg-card border border-border rounded-xl">
                        <div className="flex items-start justify-between mb-4">
                            <div className="flex gap-4">
                                <div className="p-2 bg-primary/10 rounded-lg text-primary h-fit">
                                    <Icon name="globe" size={18} />
                                </div>
                                <div className="space-y-1">
                                    <h4 className="font-medium text-foreground">Web Search</h4>
                                    <p className="text-sm text-muted-foreground">
                                        Enable AI to search the web for up-to-date information with citations.
                                    </p>
                                </div>
                            </div>
                            <Switch 
                                checked={webSearchSettings.enabled} 
                                onCheckedChange={(checked) => updateWebSearchSettings({ enabled: checked })} 
                            />
                        </div>

                        {webSearchSettings.enabled && (
                            <div className="space-y-4 pt-4 border-t border-border">
                                {/* Provider Selection */}
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-foreground">Search Provider</label>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => updateWebSearchSettings({ provider: 'tavily' })}
                                            className={cn(
                                                "flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors",
                                                webSearchSettings.provider === 'tavily'
                                                    ? "bg-primary/10 border-primary text-primary"
                                                    : "bg-card border-border text-muted-foreground hover:bg-accent"
                                            )}
                                        >
                                            Tavily (Recommended)
                                        </button>
                                        <button
                                            onClick={() => updateWebSearchSettings({ provider: 'brave' })}
                                            className={cn(
                                                "flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors",
                                                webSearchSettings.provider === 'brave'
                                                    ? "bg-primary/10 border-primary text-primary"
                                                    : "bg-card border-border text-muted-foreground hover:bg-accent"
                                            )}
                                        >
                                            Brave Search
                                        </button>
                                    </div>
                                </div>

                                {/* API Keys */}
                                {webSearchSettings.provider === 'tavily' && (
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-foreground">
                                            Tavily API Key
                                        </label>
                                        <Input
                                            type="password"
                                            placeholder="tvly-xxxxxxxxxxxxxxxx"
                                            value={webSearchSettings.tavilyApiKey}
                                            onChange={(e) => updateWebSearchSettings({ tavilyApiKey: e.target.value })}
                                            className="font-mono"
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            Get your API key at{' '}
                                            <a 
                                                href="https://tavily.com" 
                                                target="_blank" 
                                                rel="noopener noreferrer"
                                                className="text-primary hover:underline"
                                            >
                                                tavily.com
                                            </a>
                                            {' '}(1000 free searches/month)
                                        </p>
                                    </div>
                                )}

                                {webSearchSettings.provider === 'brave' && (
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-foreground">
                                            Brave Search API Key
                                        </label>
                                        <Input
                                            type="password"
                                            placeholder="BSAxxxxxxxxxxxxxxxx"
                                            value={webSearchSettings.braveApiKey}
                                            onChange={(e) => updateWebSearchSettings({ braveApiKey: e.target.value })}
                                            className="font-mono"
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            Get your API key at{' '}
                                            <a 
                                                href="https://brave.com/search/api/" 
                                                target="_blank" 
                                                rel="noopener noreferrer"
                                                className="text-primary hover:underline"
                                            >
                                                brave.com/search/api
                                            </a>
                                            {' '}(2000 free searches/month)
                                        </p>
                                    </div>
                                )}

                                {/* Status */}
                                <div className="flex items-center gap-2 text-xs pt-2">
                                    <span className={cn(
                                        "w-2 h-2 rounded-full",
                                        (webSearchSettings.provider === 'tavily' && webSearchSettings.tavilyApiKey) ||
                                        (webSearchSettings.provider === 'brave' && webSearchSettings.braveApiKey)
                                            ? "bg-emerald-500"
                                            : "bg-amber-500"
                                    )} />
                                    <span className="text-muted-foreground">
                                        {(webSearchSettings.provider === 'tavily' && webSearchSettings.tavilyApiKey) ||
                                        (webSearchSettings.provider === 'brave' && webSearchSettings.braveApiKey)
                                            ? "Configured"
                                            : "API key required"}
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </TabsContent>

                <TabsContent value="tools" className="flex-1 overflow-y-auto pr-2 space-y-3">
                    {filteredTools.map(tool => (
                        <div key={tool.id} className="flex items-start justify-between p-4 bg-card border border-border rounded-xl">
                            <div className="flex gap-4">
                                <div className="p-2 bg-primary/10 rounded-lg text-primary h-fit">
                                    <Icon name={(tool.icon as any) || 'tool'} size={18} />
                                </div>
                                <div className="space-y-1">
                                    <h4 className="font-medium text-foreground">{tool.name}</h4>
                                    <p className="text-sm text-muted-foreground">{tool.description}</p>
                                    <div className="flex gap-2">
                                        <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground capitalize">{tool.category}</span>
                                    </div>
                                </div>
                            </div>
                            <Switch 
                                checked={isToolEnabled(tool.id)} 
                                onCheckedChange={() => toggleTool(tool.id)} 
                            />
                        </div>
                    ))}
                    {filteredTools.length === 0 && (
                        <p className="text-center text-muted-foreground py-8">No tools found.</p>
                    )}
                </TabsContent>

                <TabsContent value="mcp" className="flex-1 overflow-y-auto pr-2 space-y-3">
                     {filteredServers.map(server => (
                        <div key={server.id} className="flex items-start justify-between p-4 bg-card border border-border rounded-xl">
                            <div className="flex gap-4">
                                <div className="p-2 bg-blue-500/10 rounded-lg text-blue-500 h-fit">
                                   <Icon name="database" size={18} />
                                </div>
                                <div className="space-y-1">
                                    <h4 className="font-medium text-foreground">{server.name}</h4>
                                    <p className="text-sm text-muted-foreground">{server.website || server.description}</p>
                                    <div className="flex items-center gap-2 text-xs">
                                        <span className={cn(
                                            "w-2 h-2 rounded-full",
                                            server.status === 'online' ? "bg-emerald-500" : "bg-red-500"
                                        )} />
                                        <span className="text-muted-foreground capitalize">{server.status}</span>
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
                             <p className="text-muted-foreground">No custom MCP servers configured.</p>
                             {/* Maybe hint how to add config? */}
                        </div>
                    )}
                </TabsContent>
            </Tabs>
        </div>
    );
};
