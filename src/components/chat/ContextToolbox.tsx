import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToolsStore } from '../../stores/useToolsStore';
import { Icon, IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import type { Tool } from '../../types';

interface ContextToolboxProps {
  className?: string;
}

/**
 * ContextToolbox - Provides context tools and file attachments in Chat mode
 *
 * PERFORMANCE: Lazy loaded via ModeRouter, only rendered when Chat mode is active
 */

interface AttachedFile {
  id: string;
  name: string;
  type: 'file' | 'url' | 'image';
  path?: string;
  url?: string;
}

const mockAttachedFiles: AttachedFile[] = [
  { id: 'att-1', name: 'requirements.md', type: 'file', path: '/docs/requirements.md' },
  { id: 'att-2', name: 'React Documentation', type: 'url', url: 'https://react.dev' },
  { id: 'att-3', name: 'screenshot.png', type: 'image', path: '/images/screenshot.png' },
];

const mockSummary = `Cette conversation explore les meilleures pratiques pour optimiser les performances React, notamment :

• **Memoization** avec React.memo, useMemo et useCallback
• **Code Splitting** pour charger les composants à la demande
• **Virtualization** pour les longues listes
• **State Management** optimisé

L'utilisateur cherche à améliorer les performances de son application e-commerce.`;

export const ContextToolbox: React.FC<ContextToolboxProps> = ({ className }) => {
  const { t } = useTranslation();
  const { internalTools, mcpServers } = useToolsStore();
  const [activeTab, setActiveTab] = useState<'context' | 'tools' | 'summary'>('context');

  // Filter enabled tools
  const enabledTools = Object.values(internalTools).filter((t: Tool) => t.status === 'enabled');
  const onlineMcpServers = mcpServers.filter((s) => s.status === 'online');

  const tabs: { id: 'context' | 'tools' | 'summary'; label: string; icon: IconName }[] = [
    { id: 'context', label: 'Contexte', icon: 'paperclip' },
    { id: 'tools', label: 'Outils', icon: 'tool' },
    { id: 'summary', label: 'Résumé', icon: 'file-text' },
  ];

  return (
    <aside
      className={cn("h-full w-full bg-card border-l border-border flex flex-col", className)}
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="layout-grid" size={16} className="text-primary" />
          {t('chat.toolbox', 'Toolbox')}
        </h1>
      </div>

      {/* Tabs */}
      <div className="h-10 border-b border-border flex items-center px-2 gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-all duration-200',
              activeTab === tab.id
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            <Icon name={tab.icon} size={12} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Context Tab */}
        {activeTab === 'context' && (
          <div className="space-y-4">
            {/* Attached Files */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Fichiers attachés
                </h3>
                <button className="p-1 hover:bg-accent rounded transition-colors">
                  <Icon name="plus" size={12} className="text-muted-foreground" />
                </button>
              </div>

              {mockAttachedFiles.length > 0 ? (
                <div className="space-y-2">
                  {mockAttachedFiles.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border hover:bg-accent/50 transition-colors group"
                    >
                      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                        <Icon
                          name={
                            file.type === 'file' ? 'file' :
                            file.type === 'url' ? 'link' : 'image'
                          }
                          size={14}
                          className="text-muted-foreground"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{file.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {file.path || file.url}
                        </p>
                      </div>
                      <button className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity">
                        <Icon name="x" size={12} className="text-muted-foreground" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 border border-dashed border-border rounded-lg">
                  <Icon name="paperclip" size={24} className="text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">
                    Glissez des fichiers ou URLs ici
                  </p>
                </div>
              )}
            </div>

            {/* Quick Actions */}
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                Actions rapides
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors">
                  <Icon name="upload" size={14} className="text-muted-foreground" />
                  Upload
                </button>
                <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors">
                  <Icon name="link" size={14} className="text-muted-foreground" />
                  Add URL
                </button>
                <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors">
                  <Icon name="clipboard" size={14} className="text-muted-foreground" />
                  Paste
                </button>
                <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors">
                  <Icon name="camera" size={14} className="text-muted-foreground" />
                  Screenshot
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tools Tab */}
        {activeTab === 'tools' && (
          <div className="space-y-4">
            {/* Built-in Tools */}
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                Outils intégrés
              </h3>
              <div className="space-y-1">
                {enabledTools.length > 0 ? (
                  enabledTools.map((tool) => (
                    <div
                      key={tool.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors"
                    >
                      <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Icon name={tool.icon as any} size={12} className="text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground">{tool.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {tool.description}
                        </p>
                      </div>
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Aucun outil activé
                  </p>
                )}
              </div>
            </div>

            {/* MCP Servers */}
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                Serveurs MCP
              </h3>
              <div className="space-y-1">
                {onlineMcpServers.length > 0 ? (
                  onlineMcpServers.map((server) => (
                    <div
                      key={server.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors"
                    >
                      <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center shrink-0">
                        <Icon name={server.icon as any} size={12} className="text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground">{server.name}</p>
                        <p className="text-xs text-muted-foreground">{server.category}</p>
                      </div>
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full shrink-0',
                          server.status === 'online' ? 'bg-emerald-500' :
                          server.status === 'degraded' ? 'bg-amber-500' : 'bg-muted'
                        )}
                      />
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Aucun serveur MCP connecté
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Summary Tab */}
        {activeTab === 'summary' && (
          <div className="space-y-4">
            {/* AI Summary */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Résumé IA
                </h3>
                <button className="flex items-center gap-1 px-2 py-1 rounded text-xs text-primary hover:bg-primary/10 transition-colors">
                  <Icon name="refresh-cw" size={10} />
                  Actualiser
                </button>
              </div>
              <div className="p-3 rounded-lg bg-muted/50 border border-border">
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">
                  {mockSummary}
                </p>
              </div>
            </div>

            {/* Export Options */}
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                Exporter
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <button className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors">
                  <Icon name="file-text" size={14} />
                  Markdown
                </button>
                <button className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors">
                  <Icon name="file" size={14} />
                  PDF
                </button>
                <button className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors">
                  <Icon name="copy" size={14} />
                  Copier
                </button>
                <button className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors">
                  <Icon name="share" size={14} />
                  Partager
                </button>
              </div>
            </div>

            {/* Stats */}
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                Statistiques
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-muted/50 text-center">
                  <p className="text-lg font-semibold text-foreground">12</p>
                  <p className="text-xs text-muted-foreground">Messages</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50 text-center">
                  <p className="text-lg font-semibold text-foreground">2.4k</p>
                  <p className="text-xs text-muted-foreground">Tokens</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50 text-center">
                  <p className="text-lg font-semibold text-foreground">15m</p>
                  <p className="text-xs text-muted-foreground">Durée</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50 text-center">
                  <p className="text-lg font-semibold text-foreground">3</p>
                  <p className="text-xs text-muted-foreground">Fichiers</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

// Export both named and default for lazy loading compatibility
export default ContextToolbox;
