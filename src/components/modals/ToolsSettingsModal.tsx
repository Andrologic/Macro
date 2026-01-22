import React, { useState, useMemo } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useToolsStore } from '../../stores/useToolsStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { Tabs, TabsList, TabsTrigger } from '../ui/Tabs';
import { cn } from '../../utils/cn';
import type { ToolStatus, MCPServerStatus } from '../../types';

export const ToolsSettingsModal: React.FC = () => {
  const { toolsSettingsOpen, closeToolsSettings } = useAppStore();
  const {
    internalTools,
    mcpServers,
    saving,
    loadSettings,
    toggleTool,
    toggleMCPServer,
    saveAll,
    resetToDefaults,
  } = useToolsStore();

  const [activeTab, setActiveTab] = useState<'tools' | 'mcp'>('tools');
  const [searchQuery, setSearchQuery] = useState('');

  React.useEffect(() => {
    if (toolsSettingsOpen) {
      loadSettings();
    }
  }, [toolsSettingsOpen]);

  // Filter logic
  const filteredTools = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return Object.values(internalTools).filter(
      (t) => 
        t.name.toLowerCase().includes(query) || 
        t.description.toLowerCase().includes(query) ||
        t.category.toLowerCase().includes(query)
    );
  }, [internalTools, searchQuery]);

  const filteredServers = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return mcpServers.filter(
      (s) => 
        s.name.toLowerCase().includes(query) || 
        s.description.toLowerCase().includes(query) ||
        s.category.toLowerCase().includes(query)
    );
  }, [mcpServers, searchQuery]);

  const handleSave = async () => {
    await saveAll();
    closeToolsSettings();
  };

  const handleReset = async () => {
    if (confirm('Are you sure you want to reset all tools and MCP servers to defaults?')) {
      await resetToDefaults();
    }
  };

  const getStatusBadge = (status: ToolStatus | MCPServerStatus) => {
    switch (status) {
      case 'enabled':
      case 'online':
        return <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />;
      case 'disabled':
      case 'offline':
        return <div className="w-2 h-2 rounded-full bg-zinc-700" />;
      case 'error':
        return <div className="w-2 h-2 rounded-full bg-red-500" />;
      case 'loading':
        return <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />;
      default:
        return <div className="w-2 h-2 rounded-full bg-zinc-700" />;
    }
  };

  if (!toolsSettingsOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-fade-in">
      <div className="w-[800px] h-[85vh] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden ring-1 ring-white/5">
        
        {/* Header Section */}
        <header className="shrink-0 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                <Icon name="tool" size={20} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">Tools Configuration</h2>
                <p className="text-xs text-zinc-500">Manage available capabilities and MCP servers</p>
              </div>
            </div>
            <button
              onClick={closeToolsSettings}
              className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <Icon name="x" size={18} />
            </button>
          </div>

          {/* Navigation & Search */}
          <div className="px-6 pb-4 flex items-center justify-between gap-4">
            <Tabs 
              value={activeTab} 
              defaultValue="tools"
              onValueChange={(v) => setActiveTab(v as any)} 
              className="w-auto"
            >
              <TabsList className="bg-zinc-900 border-zinc-800 p-1">
                <TabsTrigger value="tools" className="px-4 py-1.5 text-xs">Internal Tools</TabsTrigger>
                <TabsTrigger value="mcp" className="px-4 py-1.5 text-xs">MCP Servers</TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="relative flex-1 max-w-xs group">
              <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-zinc-300 transition-colors" />
              <input 
                type="text" 
                placeholder="Search tools..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all"
              />
            </div>
          </div>
        </header>

        {/* content area - Using absolute positioning for reliable scroll */}
        <div className="flex-1 relative bg-zinc-950/50">
          <div className="absolute inset-0 overflow-y-auto px-6 py-6 custom-scrollbar">
             {/* List Container */}
            <div className="space-y-2 pb-20">
              {activeTab === 'tools' ? (
                // INTERNAL TOOLS LIST
                filteredTools.length > 0 ? (
                  filteredTools.map((tool) => {
                    const isEnabled = (tool.config as any)?.enabled !== false;
                    return (
                      <div
                        key={tool.id}
                        onClick={() => toggleTool(tool.id)}
                        className={cn(
                          "group relative flex items-center gap-4 p-4 rounded-xl border transition-all duration-200 cursor-pointer select-none",
                          isEnabled 
                            ? "bg-zinc-900/40 border-indigo-500/20 hover:border-indigo-500/30 hover:bg-zinc-900/60" 
                            : "bg-transparent border-zinc-800/50 hover:bg-zinc-900/30 hover:border-zinc-700 opacity-70 hover:opacity-100"
                        )}
                      >
                        {/* Icon Box */}
                        <div className={cn(
                          "w-12 h-12 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-300",
                          isEnabled 
                            ? "bg-gradient-to-br from-indigo-500/20 to-indigo-600/5 text-indigo-400 ring-1 ring-inset ring-indigo-500/20" 
                            : "bg-zinc-900 text-zinc-600 border border-zinc-800"
                        )}>
                          <Icon name={tool.icon as any} size={22} />
                        </div>

                        {/* Text Content */}
                        <div className="flex-1 min-w-0 py-0.5">
                          <div className="flex items-center gap-3">
                            <h4 className={cn(
                              "text-sm font-medium transition-colors",
                              isEnabled ? "text-zinc-100" : "text-zinc-400 group-hover:text-zinc-300"
                            )}>
                              {tool.name}
                            </h4>
                            <span className={cn(
                              "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
                              isEnabled
                                ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/10"
                                : "bg-zinc-800 text-zinc-500 border-zinc-700"
                            )}>
                              {tool.category}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-500 mt-1 line-clamp-1">{tool.description}</p>
                        </div>

                        {/* Switch */}
                        <div className="pl-4 border-l border-zinc-800/50">
                           <div className={cn(
                             "w-10 h-5 rounded-full relative transition-colors duration-300",
                             isEnabled ? "bg-indigo-500" : "bg-zinc-700"
                           )}>
                             <div className={cn(
                               "absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300",
                               isEnabled ? "translate-x-5" : "translate-x-0.5"
                             )} />
                           </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <EmptyState query={searchQuery} />
                )
              ) : (
                // MCP SERVERS LIST
                filteredServers.length > 0 ? (
                  filteredServers.map((server) => {
                    const isEnabled = (server.config as any)?.enabled !== false;
                    return (
                      <div
                        key={server.id}
                        onClick={() => toggleMCPServer(server.id)}
                        className={cn(
                          "group relative flex items-center gap-4 p-4 rounded-xl border transition-all duration-200 cursor-pointer select-none",
                          isEnabled 
                            ? "bg-zinc-900/40 border-purple-500/20 hover:border-purple-500/30 hover:bg-zinc-900/60" 
                            : "bg-transparent border-zinc-800/50 hover:bg-zinc-900/30 hover:border-zinc-700 opacity-70 hover:opacity-100"
                        )}
                      >
                         {/* Icon Box */}
                        <div className={cn(
                          "w-12 h-12 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-300",
                          isEnabled 
                            ? "bg-gradient-to-br from-purple-500/20 to-purple-600/5 text-purple-400 ring-1 ring-inset ring-purple-500/20" 
                            : "bg-zinc-900 text-zinc-600 border border-zinc-800"
                        )}>
                          <Icon name={server.icon as any} size={22} />
                        </div>

                        {/* Text Content */}
                        <div className="flex-1 min-w-0 py-0.5">
                          <div className="flex items-center gap-3">
                            <h4 className={cn(
                              "text-sm font-medium transition-colors",
                              isEnabled ? "text-zinc-100" : "text-zinc-400 group-hover:text-zinc-300"
                            )}>
                              {server.name}
                            </h4>
                             <span className={cn(
                              "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
                              isEnabled
                                ? "bg-purple-500/10 text-purple-400 border-purple-500/10"
                                : "bg-zinc-800 text-zinc-500 border-zinc-700"
                            )}>
                              {server.category}
                            </span>
                          </div>
                           <p className="text-xs text-zinc-500 mt-1 line-clamp-1">{server.description}</p>
                        </div>

                         {/* Status & Switch */}
                        <div className="flex items-center gap-4 pl-4 border-l border-zinc-800/50">
                           <div className="flex items-center">
                              <span className={cn(
                                "text-[10px] font-medium",
                                isEnabled ? "text-emerald-500" : "text-zinc-600"
                              )}>
                                {server.status === 'online' ? 'Online' : 'Offline'}
                              </span>
                           </div>
                           
                           {/* Custom Switch */}
                           <div className={cn(
                             "w-10 h-5 rounded-full relative transition-colors duration-300",
                             isEnabled ? "bg-purple-500" : "bg-zinc-700"
                           )}>
                             <div className={cn(
                               "absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300",
                               isEnabled ? "translate-x-5" : "translate-x-0.5"
                             )} />
                           </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <EmptyState query={searchQuery} />
                )
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className="shrink-0 h-16 bg-zinc-900/80 border-t border-zinc-800 px-6 flex items-center justify-between backdrop-blur-sm">
          <div className="flex items-center gap-4">
             <button
              onClick={handleReset}
              disabled={saving}
              className="text-xs font-medium text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-2"
            >
              <Icon name="rotate-ccw" size={12} />
              Reset defaults
            </button>
            <span className="text-xs text-zinc-700 border-l border-zinc-800 pl-4 h-4 flex items-center">
              Changes auto-save
            </span>
          </div>
          
          <div className="flex items-center gap-3">
             <Button
              variant="ghost"
              size="sm"
              onClick={closeToolsSettings}
              className="text-zinc-400 hover:text-zinc-100"
            >
              Close
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              isLoading={saving}
              className="bg-indigo-500 hover:bg-indigo-600 text-white min-w-[100px]"
            >
               {saving ? 'Saving...' : 'Done'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
};

// Helper for empty list
const EmptyState = ({ query }: { query: string }) => (
  <div className="flex flex-col items-center justify-center py-20 text-center">
    <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
      <Icon name="search" size={24} className="text-zinc-600" />
    </div>
    <h3 className="text-zinc-300 font-medium mb-1">No tools found</h3>
    <p className="text-zinc-500 text-xs max-w-[200px]">
      We couldn't find any tools matching "{query}". Try a different search term.
    </p>
  </div>
);
