import React, { useState, useMemo, useEffect } from 'react';
import { useToolsStore } from '../../../stores/useToolsStore';
import { Icon } from '../../ui/Icon';
// @ts-ignore
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/Tabs';
import { Input } from '../../ui/Input';
import { Switch } from '../../ui/Switch';
import { cn } from '../../../utils/cn';

export const ToolsView: React.FC = () => {
    const {
        internalTools,
        mcpServers,
        loadSettings,
        toggleTool,
        toggleMCPServer,
    } = useToolsStore();

    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    const filteredTools = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return Object.values(internalTools).filter(
            (t) => 
                t.name.toLowerCase().includes(query) || 
                t.description.toLowerCase().includes(query)
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

            <Tabs defaultValue="tools" className="flex-1 flex flex-col overflow-hidden">
                <TabsList className="mb-4">
                    <TabsTrigger value="tools" className="flex items-center gap-2">
                        <Icon name="tool" size={14} />
                        Built-in Tools
                    </TabsTrigger>
                    <TabsTrigger value="mcp" className="flex items-center gap-2">
                        <Icon name="server" size={14} />
                        MCP Servers
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="tools" className="flex-1 overflow-y-auto pr-2 space-y-3">
                    {filteredTools.map(tool => (
                        <div key={tool.id} className="flex items-start justify-between p-4 bg-card border border-border rounded-xl">
                            <div className="flex gap-4">
                                <div className="p-2 bg-primary/10 rounded-lg text-primary h-fit">
                                    <Icon name={tool.id === 'read_file' ? 'file-text' : 'terminal'} size={18} />
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
                                checked={tool.status === 'enabled'} 
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
