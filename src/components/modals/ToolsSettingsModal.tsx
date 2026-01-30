import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useToolsStore } from '../../stores/useToolsStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { Tabs, TabsList, TabsTrigger } from '../ui/Tabs';
import { toast } from '../ui/Toaster';
import { cn } from '../../utils/cn';
import type { ToolStatus, MCPServerStatus } from '../../types';

export const ToolsSettingsModal: React.FC = () => {
  const { t } = useTranslation();
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
    toast.success(t('toast.settingsSaved'));
    closeToolsSettings();
  };

  const handleReset = async () => {
    if (confirm(t('tools.resetConfirm'))) {
      await resetToDefaults();
      toast.success(t('toast.settingsReset'));
    }
  };

  const getStatusBadge = (status: ToolStatus | MCPServerStatus) => {
    switch (status) {
      case 'enabled':
      case 'online':
        return <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />;
      case 'disabled':
      case 'offline':
        return <div className="w-2 h-2 rounded-full bg-muted" />;
      case 'error':
        return <div className="w-2 h-2 rounded-full bg-red-500" />;
      case 'loading':
        return <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />;
      default:
        return <div className="w-2 h-2 rounded-full bg-muted" />;
    }
  };

  if (!toolsSettingsOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-fade-in">
      <div className="w-[800px] h-[85vh] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden ring-1 ring-white/5">
        
        {/* Header Section */}
        <header className="shrink-0 border-b border-border bg-card/50">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                <Icon name="tool" size={20} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">{t('tools.title')}</h2>
                <p className="text-xs text-muted-foreground">{t('tools.subtitle')}</p>
              </div>
            </div>
            <button
              onClick={closeToolsSettings}
              className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              aria-label={t('common.close')}
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
              <TabsList className="bg-card border-border p-1">
                <TabsTrigger value="tools" className="px-4 py-1.5 text-xs">{t('tools.internalTools')}</TabsTrigger>
                <TabsTrigger value="mcp" className="px-4 py-1.5 text-xs">{t('tools.mcpServers')}</TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="relative flex-1 max-w-xs group">
              <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-foreground transition-colors" />
              <input 
                type="text" 
                placeholder={t('tools.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-muted border border-border rounded-lg pl-9 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all"
              />
            </div>
          </div>
        </header>

        {/* content area - Using absolute positioning for reliable scroll */}
        <div className="flex-1 relative bg-background/50">
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
                            ? "bg-card/40 border-primary/20 hover:border-primary/30 hover:bg-card/60" 
                            : "bg-transparent border-border/50 hover:bg-card/30 hover:border-border opacity-70 hover:opacity-100"
                        )}
                      >
                        {/* Icon Box */}
                        <div className={cn(
                          "w-12 h-12 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-300",
                          isEnabled 
                            ? "bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-inset ring-primary/20" 
                            : "bg-card text-muted-foreground border border-border"
                        )}>
                          <Icon name={tool.icon as any} size={22} />
                        </div>

                        {/* Text Content */}
                        <div className="flex-1 min-w-0 py-0.5">
                          <div className="flex items-center gap-3">
                            <h4 className={cn(
                              "text-sm font-medium transition-colors",
                              isEnabled ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                            )}>
                              {tool.name}
                            </h4>
                            <span className={cn(
                              "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
                              isEnabled
                                ? "bg-primary/10 text-primary border-primary/10"
                                : "bg-muted text-muted-foreground border-border"
                            )}>
                              {tool.category}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{tool.description}</p>
                        </div>

                        {/* Switch */}
                        <div className="pl-4 border-l border-border/50">
                           <div className={cn(
                             "w-10 h-5 rounded-full relative transition-colors duration-300",
                             isEnabled ? "bg-primary" : "bg-muted"
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
                  <EmptyState query={searchQuery} t={t} />
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
                            ? "bg-card/40 border-primary/20 hover:border-primary/30 hover:bg-card/60" 
                            : "bg-transparent border-border/50 hover:bg-card/30 hover:border-border opacity-70 hover:opacity-100"
                        )}
                      >
                         {/* Icon Box */}
                        <div className={cn(
                          "w-12 h-12 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-300",
                          isEnabled 
                            ? "bg-gradient-to-br from-purple-500/20 to-purple-600/5 text-purple-400 ring-1 ring-inset ring-purple-500/20" 
                            : "bg-card text-muted-foreground border border-border"
                        )}>
                          <Icon name={server.icon as any} size={22} />
                        </div>

                        {/* Text Content */}
                        <div className="flex-1 min-w-0 py-0.5">
                          <div className="flex items-center gap-3">
                            <h4 className={cn(
                              "text-sm font-medium transition-colors",
                              isEnabled ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                            )}>
                              {server.name}
                            </h4>
                             <span className={cn(
                              "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
                              isEnabled
                                ? "bg-purple-500/10 text-purple-400 border-purple-500/10"
                                : "bg-muted text-muted-foreground border-border"
                            )}>
                              {server.category}
                            </span>
                          </div>
                           <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{server.description}</p>
                        </div>

                         {/* Status & Switch */}
                        <div className="flex items-center gap-4 pl-4 border-l border-border/50">
                           <div className="flex items-center">
                              <span className={cn(
                                "text-[10px] font-medium",
                                isEnabled ? "text-emerald-500" : "text-muted-foreground/70"
                              )}>
                                {server.status === 'online' ? t('common.online') : t('common.offline')}
                              </span>
                           </div>
                           
                           {/* Custom Switch */}
                           <div className={cn(
                             "w-10 h-5 rounded-full relative transition-colors duration-300",
                             isEnabled ? "bg-primary" : "bg-muted"
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
                  <EmptyState query={searchQuery} t={t} />
                )
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className="shrink-0 h-16 bg-card/80 border-t border-border px-6 flex items-center justify-between backdrop-blur-sm">
          <div className="flex items-center gap-4">
             <button
              onClick={handleReset}
              disabled={saving}
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2"
            >
              <Icon name="rotate-ccw" size={12} />
              {t('tools.resetDefaults')}
            </button>
            <span className="text-xs text-muted-foreground/70 border-l border-border pl-4 h-4 flex items-center">
              {t('tools.changesAutoSave')}
            </span>
          </div>
          
          <div className="flex items-center gap-3">
             <Button
              variant="ghost"
              size="sm"
              onClick={closeToolsSettings}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('common.close')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              isLoading={saving}
              className="min-w-[100px]"
            >
               {saving ? t('common.saving') : t('common.done')}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
};

// Helper for empty list
const EmptyState = ({ query, t }: { query: string; t: (key: string) => string }) => (
  <div className="flex flex-col items-center justify-center py-20 text-center">
    <div className="w-16 h-16 rounded-2xl bg-card border border-border flex items-center justify-center mb-4">
      <Icon name="search" size={24} className="text-muted-foreground" />
    </div>
    <h3 className="text-foreground font-medium mb-1">{t('tools.noToolsFound')}</h3>
    <p className="text-muted-foreground text-xs max-w-[200px]">
      {t('tools.noToolsFoundHint').replace('{query}', query)}
    </p>
  </div>
);
