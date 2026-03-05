import React, { useState, useMemo, useEffect } from 'react';
import { useToolsStore } from '../../../stores/useToolsStore';
import { Icon } from '../../ui/Icon';
// @ts-ignore
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/Tabs';
import { Input } from '../../ui/Input';
import { Switch } from '../../ui/Switch';
import { cn } from '../../../utils/cn';
import { useAppStore } from '../../../stores/useAppStore';
import { getToolModePolicy } from '../../../services/toolModePolicy';
import {
  WebSearchSettings,
  getWebSearchSettings,
  saveWebSearchSettings,
} from '../../../services/webSearchSettings';

export const ToolsView: React.FC = () => {
    const {
        internalTools,
        mcpServers,
        loadSettings,
        toggleTool,
        toggleMCPServer,
        isToolEnabled,
    } = useToolsStore();
    const mode = useAppStore((state) => state.mode);

    const chatPolicy = useMemo(() => getToolModePolicy('Chat'), []);
    const architectPolicy = useMemo(() => getToolModePolicy('Architect'), []);
    const implementPolicy = useMemo(() => getToolModePolicy('Implement'), []);
    const debugPolicy = useMemo(() => getToolModePolicy('Debug'), []);

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
               <div className="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                 {mode === 'Chat'
                   ? 'Chat mode: user-selected tools from the Chat toolbox are respected before execution.'
                                     : mode === 'Debug'
                                         ? 'Debug mode: all globally enabled tools are available for testing (no chat-mode restriction).'
                                         : 'Architect/Implement: enabled tools may run automatically when the model needs them; usage is shown inline in chat.'}
               </div>
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
                        </div>
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
                                        hasSelectedWebSearchKey
                                            ? "bg-emerald-500"
                                            : "bg-amber-500"
                                    )} />
                                    <span className="text-muted-foreground">
                                        {hasSelectedWebSearchKey
                                            ? "Configured"
                                            : "API key required to enable Web Search"}
                                    </span>
                                </div>
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="tools" className="flex-1 overflow-y-auto pr-2 space-y-3">
                    {filteredTools.map(tool => (
                        (() => {
                            const webSearchLockedByKey =
                                tool.id === 'web_search' && !hasSelectedWebSearchKey;

                            return (
                        <div
                            key={tool.id}
                            className={cn(
                                'relative group flex items-start justify-between p-4 bg-card border border-border rounded-xl',
                                webSearchLockedByKey && 'cursor-help'
                            )}
                        >
                            <div className={cn('flex gap-4', webSearchLockedByKey && 'opacity-50')}>
                                <div className="p-2 bg-primary/10 rounded-lg text-primary h-fit">
                                    <Icon name={(tool.icon as any) || 'tool'} size={18} />
                                </div>
                                <div className="space-y-1">
                                    <h4 className="font-medium text-foreground">{tool.name}</h4>
                                    <p className="text-sm text-muted-foreground">{tool.description}</p>
                                    <div className="flex gap-2">
                                        <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground capitalize">{tool.category}</span>
                                                                                {chatPolicy.allowedToolIds.includes(tool.id) && (
                                                                                    <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">Chat</span>
                                                                                )}
                                                                                {architectPolicy.allowedToolIds.includes(tool.id) && (
                                                                                    <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">Architect</span>
                                                                                )}
                                                                                {implementPolicy.allowedToolIds.includes(tool.id) && (
                                                                                    <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">Implement</span>
                                                                                )}
                                                                                {debugPolicy.allowedToolIds.includes(tool.id) && (
                                                                                    <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">Debug</span>
                                                                                )}
                                                                                {(tool.id === 'write' || tool.id === 'edit') && (
                                                                                    <span className="text-xs bg-amber-500/10 px-2 py-0.5 rounded text-amber-600 dark:text-amber-400">Architect: @macro only</span>
                                                                                )}
                                    </div>
                                </div>
                            </div>
                            <Switch 
                                checked={webSearchLockedByKey ? false : isToolEnabled(tool.id)} 
                                disabled={webSearchLockedByKey}
                                onCheckedChange={() => {
                                    if (webSearchLockedByKey) return;
                                    void toggleTool(tool.id);
                                }} 
                                className={cn(webSearchLockedByKey && 'opacity-50')}
                                id={tool.id}
                            />
                            {webSearchLockedByKey && (
                                <div className="pointer-events-none absolute -top-2 right-3 hidden group-hover:block z-10">
                                    <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-md whitespace-nowrap">
                                        Add an API key in Web Search settings to enable this tool.
                                    </div>
                                </div>
                            )}
                        </div>
                            );
                        })()
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
