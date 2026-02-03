import React, { useEffect } from 'react';
import { useToolsStore } from '../../../stores/useToolsStore';
import { McpServerPanel } from '../McpServerPanel';
import { Icon } from '../../ui/Icon';
// @ts-ignore
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/Tabs';

export const ToolsView: React.FC = () => {
    const {
        loadSettings,
    } = useToolsStore();

    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    return (
        <div className="h-full flex flex-col animate-in fade-in slide-in-from-bottom-2 duration-300">
            <Tabs defaultValue="mcp" className="flex-1 flex flex-col overflow-hidden">
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

                <TabsContent value="tools" className="flex-1 overflow-y-auto pr-2">
                    <div className="text-center py-12">
                        <div className="w-12 h-12 mx-auto mb-3 rounded-lg bg-muted/50 flex items-center justify-center">
                            <Icon name="tool" size={24} className="text-muted-foreground" />
                        </div>
                        <p className="text-muted-foreground text-sm">
                            No built-in tools available yet.
                            <br />
                            Check the MCP Servers tab to add external tools.
                        </p>
                    </div>
                </TabsContent>

                <TabsContent value="mcp" className="flex-1 overflow-hidden">
                    <McpServerPanel />
                </TabsContent>
            </Tabs>
        </div>
    );
};
