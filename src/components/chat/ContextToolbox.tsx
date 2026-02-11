import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToolsStore } from '../../stores/useToolsStore';
import { useCitationsStore } from '../../stores/useCitationsStore';
import { useChatStore } from '../../stores/useChatStore';
import { Icon, IconName } from '../ui/Icon';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { cn } from '../../utils/cn';
import { extractDomain, getFaviconUrl } from '../../services/webSearch';

interface ContextToolboxProps {
  className?: string;
}

/**
 * ContextToolbox - Provides context tools and file attachments in Chat mode
 *
 * PERFORMANCE: Lazy loaded via ModeRouter, only rendered when Chat mode is active
 */

export const ContextToolbox: React.FC<ContextToolboxProps> = ({ className }) => {
  const { t } = useTranslation();
  const { getChatModeTools, isChatToolEnabled, toggleChatTool, mcpServers } = useToolsStore();
  const {
    getConversationContextCitations,
    getConversationSourceCitations,
    addCitation,
    removeCitation,
  } = useCitationsStore();
  const { selectedConversationId, createConversation } = useChatStore();
  const [activeTab, setActiveTab] = useState<'context' | 'tools' | 'sources'>('context');
  const [isDragging, setIsDragging] = useState(false);
  const [isAddingUrl, setIsAddingUrl] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Get citations for current conversation
  const contextCitations = selectedConversationId
    ? getConversationContextCitations(selectedConversationId)
    : [];
  const sourceCitations = selectedConversationId
    ? getConversationSourceCitations(selectedConversationId)
    : [];
  const webCitations = contextCitations.filter((c) => c.type === 'web');
  const fileCitations = contextCitations.filter((c) => c.type === 'file' || c.type === 'document');

  // Filter enabled tools
  const chatTools = getChatModeTools();
  const onlineMcpServers = mcpServers.filter((s) => s.status === 'online');

  const tabs: { id: 'context' | 'tools' | 'sources'; label: string; icon: IconName }[] = [
    { id: 'context', label: 'Contexte', icon: 'paperclip' },
    { id: 'tools', label: 'Outils', icon: 'tool' },
    { id: 'sources', label: 'Sources', icon: 'file-text' },
  ];

  useEffect(() => {
    if (isAddingUrl) {
      urlInputRef.current?.focus();
    }
  }, [isAddingUrl]);

  // Open URL in external browser
  const openUrl = (url: string) => {
    // Fallback to window.open for web mode
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const ensureConversation = async () => {
    if (selectedConversationId) return selectedConversationId;
    const conversation = await createConversation(t('chat.newChat', 'New Chat'), null, null);
    return conversation.id;
  };

  const readFileContent = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  };

  const handleFileSelect = async (files: FileList | null) => {
    if (!files) return;
    const conversationId = await ensureConversation();
    
    for (const file of files) {
      try {
        const content = await readFileContent(file);
        addCitation({
          type: 'file',
          scope: 'context',
          source: file.name,
          title: file.name,
          snippet: content.slice(0, 1000) + (content.length > 1000 ? '...' : ''),
          path: file.name,
          messageId: `manual-${Date.now()}`,
          conversationId: conversationId,
        });
      } catch (error) {
        console.error('Failed to read file:', error);
      }
    }
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (activeTab !== 'context') return;
    e.preventDefault();
    setIsDragging(true);
  }, [activeTab]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect]);

  const normalizeUrl = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  };

  const isValidWebUrl = (value: string): boolean => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const handleOpenAddUrl = () => {
    setIsAddingUrl(true);
    setUrlError('');
  };

  const handleCancelAddUrl = () => {
    setIsAddingUrl(false);
    setUrlInput('');
    setUrlError('');
  };

  const handleAddUrl = async () => {
    const normalizedUrl = normalizeUrl(urlInput);
    if (!normalizedUrl) {
      setUrlError(t('chat.enterUrl', 'Enter URL:'));
      return;
    }
    if (!isValidWebUrl(normalizedUrl)) {
      setUrlError(t('chat.invalidUrl', 'Invalid URL'));
      return;
    }

    const conversationId = await ensureConversation();
    
    // Minimal citation since we don't have a search/fetch results here
    addCitation({
      type: 'web',
      scope: 'context',
      source: normalizedUrl,
      title: extractDomain(normalizedUrl),
      url: normalizedUrl,
      messageId: `manual-${Date.now()}`,
      conversationId: conversationId,
    });

    setUrlInput('');
    setUrlError('');
    setIsAddingUrl(false);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;

      const conversationId = await ensureConversation();
      addCitation({
        type: 'document',
        scope: 'context',
        source: 'Clipboard',
        title: 'Clipboard text',
        snippet: text.slice(0, 1000) + (text.length > 1000 ? '...' : ''),
        messageId: `manual-${Date.now()}`,
        conversationId: conversationId,
      });
    } catch (err) {
      console.error('Failed to read clipboard:', err);
    }
  };

  return (
    <aside
      className={cn("h-full w-full bg-card border-l border-border flex flex-col", className)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="layout-grid" size={16} className="text-primary" />
          {t('chat.toolbox', 'Toolbox')}
        </h1>
      </div>

      {/* Tabs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleFileSelect(e.target.files)}
      />
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
      <div className="flex-1 overflow-y-auto p-4 relative">
        {isDragging && activeTab === 'context' && (
          <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary/50 m-4 rounded-lg flex items-center justify-center z-10 pointer-events-none">
            <div className="text-center">
              <Icon name="upload" size={24} className="text-primary mx-auto mb-2" />
              <p className="text-sm text-primary font-medium">Déposez ici</p>
            </div>
          </div>
        )}

        {/* Context Tab */}
        {activeTab === 'context' && (
          <div className="space-y-4">
            {/* Attached Files */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Fichiers attachés
                </h3>
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="p-1 hover:bg-accent rounded transition-colors"
                >
                  <Icon name="plus" size={12} className="text-muted-foreground" />
                </button>
              </div>

              {fileCitations.length > 0 ? (
                <div className="space-y-2">
                  {fileCitations.map((citation) => (
                    <div
                      key={citation.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border hover:bg-accent/50 transition-colors group"
                    >
                      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                        <Icon name="file" size={14} className="text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{citation.title}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {citation.path || citation.source}
                        </p>
                      </div>
                      <button 
                        onClick={() => removeCitation(citation.id)}
                        className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Icon name="x" size={12} className="text-muted-foreground" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div 
                  className="text-center py-6 border border-dashed border-border rounded-lg cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Icon name="paperclip" size={24} className="text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">
                    Glissez des fichiers ici
                  </p>
                </div>
              )}
            </div>

            {/* Added Links */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <Icon name="link" size={12} />
                  Liens ajoutés
                </h3>
                {webCitations.length > 0 && (
                  <span className="text-xs text-muted-foreground">{webCitations.length}</span>
                )}
              </div>

              {webCitations.length > 0 ? (
                <div className="space-y-2">
                  {webCitations.map((citation) => (
                    <div
                      key={citation.id}
                      className="flex items-start gap-3 px-3 py-2 rounded-lg border border-border hover:bg-accent/50 transition-colors group"
                    >
                      <button
                        onClick={() => citation.url && openUrl(citation.url)}
                        className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0 hover:bg-accent transition-colors overflow-hidden"
                      >
                        {citation.url ? (
                          <img
                            src={getFaviconUrl(citation.url)}
                            alt=""
                            className="w-4 h-4"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <Icon name="globe" size={14} className="text-muted-foreground" />
                        )}
                      </button>
                      <button
                        onClick={() => citation.url && openUrl(citation.url)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <p className="text-sm text-foreground truncate group-hover:text-primary transition-colors">
                          {citation.title}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {citation.url || citation.source}
                        </p>
                      </button>
                      <button
                        onClick={() => removeCitation(citation.id)}
                        className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Icon name="x" size={12} className="text-muted-foreground" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 border border-dashed border-border rounded-lg">
                  <Icon name="link" size={24} className="text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">
                    Aucun lien ajouté
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
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors"
                >
                  <Icon name="upload" size={14} className="text-muted-foreground" />
                  Upload
                </button>
                <button 
                  onClick={handleOpenAddUrl}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors"
                >
                  <Icon name="link" size={14} className="text-muted-foreground" />
                  Add URL
                </button>
                <button 
                  onClick={handlePaste}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors"
                >
                  <Icon name="clipboard" size={14} className="text-muted-foreground" />
                  Paste
                </button>
                <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors opacity-50 cursor-not-allowed">
                  <Icon name="camera" size={14} className="text-muted-foreground" />
                  Screenshot
                </button>
              </div>
              {isAddingUrl && (
                <div className="mt-2 p-3 rounded-lg border border-border bg-accent/20 space-y-2">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Add URL
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      ref={urlInputRef}
                      value={urlInput}
                      onChange={(e) => {
                        setUrlInput(e.target.value);
                        if (urlError) setUrlError('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddUrl();
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          handleCancelAddUrl();
                        }
                      }}
                      error={Boolean(urlError)}
                      placeholder="https://example.com/article"
                      className="h-9"
                    />
                    <button
                      onClick={handleAddUrl}
                      className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                    >
                      Add
                    </button>
                    <button
                      onClick={handleCancelAddUrl}
                      className="h-9 px-3 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                  {urlError && (
                    <p className="text-xs text-red-500">{urlError}</p>
                  )}
                </div>
              )}
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
                {chatTools.length > 0 ? (
                  chatTools.map((tool) => (
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
                      <div className="flex items-center shrink-0">
                        <Switch
                          checked={isChatToolEnabled(tool.id)}
                          onCheckedChange={() => toggleChatTool(tool.id)}
                        />
                      </div>
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

        {/* Sources Tab */}
        {activeTab === 'sources' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <Icon name="book-open" size={12} />
                Passages importants
              </h3>
              {sourceCitations.length > 0 && (
                <span className="text-xs text-muted-foreground">{sourceCitations.length}</span>
              )}
            </div>

            {sourceCitations.length > 0 ? (
              <div className="space-y-2">
                {sourceCitations.map((citation) => (
                  <div
                    key={citation.id}
                    className="flex items-start gap-3 px-3 py-2 rounded-lg border border-border hover:bg-accent/50 transition-colors"
                  >
                    <div className="w-6 h-6 rounded bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Icon name="file-text" size={12} className="text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">{citation.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {citation.url || citation.source}
                      </p>
                      {citation.snippet && (
                        <p className="text-xs text-muted-foreground/80 line-clamp-3 mt-1">
                          {citation.snippet}
                        </p>
                      )}
                    </div>
                    {citation.url && (
                      <button
                        onClick={() => openUrl(citation.url!)}
                        className="p-1 rounded hover:bg-accent transition-colors"
                      >
                        <Icon name="external-link" size={12} className="text-muted-foreground" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Icon name="book-open" size={32} className="text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">
                  Aucun passage important
                </p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Les passages apparaissent ici quand l'IA appelle l'outil de marquage
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

// Export both named and default for lazy loading compatibility
export default ContextToolbox;
