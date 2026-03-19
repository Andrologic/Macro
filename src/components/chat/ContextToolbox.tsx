import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useToolsStore } from '../../stores/useToolsStore';
import { useCitationsStore } from '../../stores/useCitationsStore';
import { useChatStore } from '../../stores/useChatStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { Icon, IconName } from '../ui/Icon';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { cn } from '../../utils/cn';
import { extractDomain, fetchWebPage, getFaviconUrl } from '../../services/webSearch';
import { getWebSearchSettings } from '../../services/webSearchSettings';

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
    getConversationInterestingSourceCitations,
    getConversationUsedSourceCitations,
    addCitation,
    removeCitation,
  } = useCitationsStore();
  const { selectedConversationId, createConversation } = useChatStore();
  const nativeToolsSupported = useProviderStore((state) => state.selectedSupportsNativeToolCalling());
  const [activeTab, setActiveTab] = useState<'context' | 'tools' | 'sources'>('context');
  const [isDragging, setIsDragging] = useState(false);
  const [isAddingUrl, setIsAddingUrl] = useState(false);
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'interesting' | 'used'>('all');
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceSort, setSourceSort] = useState<'recent' | 'title' | 'source'>('recent');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const webSearchSettings = getWebSearchSettings();
  const hasSelectedWebSearchKey = webSearchSettings.provider === 'tavily'
    ? webSearchSettings.tavilyApiKey.trim().length > 0
    : webSearchSettings.braveApiKey.trim().length > 0;

  // Get citations for current conversation
  const contextCitations = selectedConversationId
    ? getConversationContextCitations(selectedConversationId)
    : [];
  const interestingSourceCitations = selectedConversationId
    ? getConversationInterestingSourceCitations(selectedConversationId)
    : [];
  const usedSourceCitations = selectedConversationId
    ? getConversationUsedSourceCitations(selectedConversationId)
    : [];
  const sourceCitationsCount = interestingSourceCitations.length + usedSourceCitations.length;
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

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
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
    
    setIsFetchingUrl(true);
    try {
      const settings = getWebSearchSettings();
      const shouldFetch = settings.fetchEnabled;

      if (shouldFetch) {
        const fetched = await fetchWebPage(normalizedUrl);
        addCitation({
          type: 'web',
          scope: 'context',
          source: fetched.url,
          title: fetched.title,
          snippet: fetched.snippet,
          url: fetched.url,
          messageId: `manual-${Date.now()}`,
          conversationId: conversationId,
        });
      } else {
        addCitation({
          type: 'web',
          scope: 'context',
          source: normalizedUrl,
          title: extractDomain(normalizedUrl),
          url: normalizedUrl,
          messageId: `manual-${Date.now()}`,
          conversationId: conversationId,
        });
      }
    } catch (error) {
      console.error('Failed to fetch URL preview, adding raw link instead:', error);
      addCitation({
        type: 'web',
        scope: 'context',
        source: normalizedUrl,
        title: extractDomain(normalizedUrl),
        url: normalizedUrl,
        messageId: `manual-${Date.now()}`,
        conversationId: conversationId,
      });
    } finally {
      setIsFetchingUrl(false);
    }

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

  const goToMessage = (messageId: string) => {
    window.dispatchEvent(new CustomEvent('macro:focus-message', { detail: { messageId } }));
  };

  const copyCitationSnippet = async (snippet?: string) => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
    } catch (error) {
      console.error('Failed to copy source snippet:', error);
    }
  };

  const formatRelativeTime = (timestamp: string): string => {
    const ts = new Date(timestamp).getTime();
    if (!Number.isFinite(ts)) return '';
    const diffMs = Date.now() - ts;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d`;
  };

  const allSourceCitations = useMemo(() => {
    return [...interestingSourceCitations, ...usedSourceCitations];
  }, [interestingSourceCitations, usedSourceCitations]);

  const uniqueSourceCount = useMemo(() => {
    return new Set(
      allSourceCitations
        .map((citation) => citation.url || citation.source || citation.title)
        .filter(Boolean)
    ).size;
  }, [allSourceCitations]);

  const filteredSourceCitations = useMemo(() => {
    const normalizedSearch = sourceSearch.trim().toLowerCase();

    let next = allSourceCitations.filter((citation) => {
      const kind = citation.kind || 'used';
      if (sourceFilter !== 'all' && kind !== sourceFilter) return false;
      if (!normalizedSearch) return true;

      return [citation.title, citation.snippet, citation.source, citation.url, citation.reason]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedSearch));
    });

    next = [...next].sort((a, b) => {
      if (sourceSort === 'title') {
        return a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
      }
      if (sourceSort === 'source') {
        const aSource = (a.url || a.source || '').toLowerCase();
        const bSource = (b.url || b.source || '').toLowerCase();
        return aSource.localeCompare(bSource, 'fr', { sensitivity: 'base' });
      }
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    return next;
  }, [allSourceCitations, sourceFilter, sourceSearch, sourceSort]);

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
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors min-w-0"
                >
                  <Icon name="upload" size={14} className="text-muted-foreground" />
                  <span className="truncate">Upload</span>
                </button>
                <button 
                  onClick={handleOpenAddUrl}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors min-w-0"
                >
                  <Icon name="link" size={14} className="text-muted-foreground" />
                  <span className="truncate">Add URL</span>
                </button>
                <button 
                  onClick={handlePaste}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors min-w-0"
                >
                  <Icon name="clipboard" size={14} className="text-muted-foreground" />
                  <span className="truncate">Paste</span>
                </button>
                <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors opacity-50 cursor-not-allowed min-w-0 overflow-hidden">
                  <Icon name="camera" size={14} className="text-muted-foreground" />
                  <span className="truncate">Screenshot</span>
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
                      disabled={isFetchingUrl}
                      className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                    >
                      {isFetchingUrl ? 'Fetching...' : 'Add'}
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
            {!nativeToolsSupported && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Les outils sont indisponibles pour le provider ou le modèle actuellement sélectionné. Sélectionnez un modèle compatible avec le tool calling natif pour les activer.
              </div>
            )}
            {/* Built-in Tools */}
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                Outils intégrés
              </h3>
              <div className="space-y-1">
                {chatTools.length > 0 ? (
                  chatTools.map((tool) => (
                    (() => {
                      const webSearchLockedByKey = tool.id === 'web_search' && !hasSelectedWebSearchKey;
                      const switchDisabled = webSearchLockedByKey || !nativeToolsSupported;

                      return (
                    <div
                      key={tool.id}
                      className={cn(
                        'relative group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors',
                        switchDisabled && 'opacity-50'
                      )}
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
                          disabled={switchDisabled}
                          onCheckedChange={() => {
                            if (switchDisabled) return;
                            toggleChatTool(tool.id);
                          }}
                        />
                      </div>
                      {webSearchLockedByKey && (
                        <div className="pointer-events-none absolute -top-2 right-2 hidden group-hover:block z-10">
                          <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-md whitespace-nowrap">
                            Ajoutez une clé API dans Paramètres &gt; Outils &gt; Web Search
                          </div>
                        </div>
                      )}
                      {!webSearchLockedByKey && !nativeToolsSupported && (
                        <div className="pointer-events-none absolute -top-2 right-2 hidden group-hover:block z-10">
                          <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-md whitespace-nowrap">
                            Le modèle sélectionné ne supporte pas les tool calls natifs.
                          </div>
                        </div>
                      )}
                    </div>
                      );
                    })()
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
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <Icon name="book-open" size={12} />
                Sources
              </h3>
              <span className="text-xs text-muted-foreground">
                {interestingSourceCitations.length} repérés • {usedSourceCitations.length} utilisés • {uniqueSourceCount} sources
              </span>
            </div>

            {!isChatToolEnabled('mark_source_passage') && (
              <div className="rounded-md border border-muted bg-muted/50 px-2.5 py-1.5">
                <p className="text-[11px] text-muted-foreground">
                  <span className="font-medium">Collecte désactivée</span> — activez l'outil Sources pour enregistrer de nouveaux passages.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Input
                value={sourceSearch}
                onChange={(e) => setSourceSearch(e.target.value)}
                placeholder="Rechercher dans les sources"
                className="h-9"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSourceFilter('all')}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-md border transition-colors',
                    sourceFilter === 'all' ? 'bg-primary/10 text-primary border-primary/30' : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                  )}
                >
                  Tout
                </button>
                <button
                  onClick={() => setSourceFilter('interesting')}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-md border transition-colors',
                    sourceFilter === 'interesting' ? 'bg-amber-500/10 text-amber-600 border-amber-500/30' : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                  )}
                >
                  Repérés
                </button>
                <button
                  onClick={() => setSourceFilter('used')}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-md border transition-colors',
                    sourceFilter === 'used' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                  )}
                >
                  Utilisés
                </button>
                <select
                  value={sourceSort}
                  onChange={(e) => setSourceSort(e.target.value as 'recent' | 'title' | 'source')}
                  className="ml-auto shrink-0 h-8 w-auto rounded-md border border-border bg-card pl-2 pr-7 text-xs text-muted-foreground"
                >
                  <option value="recent">Plus récent</option>
                  <option value="title">Titre</option>
                  <option value="source">Source</option>
                </select>
              </div>
            </div>

            {sourceCitationsCount > 0 ? (
              <div className="space-y-2">
                {filteredSourceCitations.length > 0 ? filteredSourceCitations.map((citation) => {
                  const kind = citation.kind || 'used';
                  const isInteresting = kind === 'interesting';
                  return (
                    <div
                      key={citation.id}
                      className={cn(
                        'rounded-lg border px-2.5 py-1.5 transition-colors hover:bg-accent/50',
                        isInteresting ? 'border-amber-500/20 bg-amber-500/5' : 'border-emerald-500/20 bg-emerald-500/5'
                      )}
                    >
                      <div className="flex items-start gap-1.5">
                        <div className={cn(
                          'w-5 h-5 rounded flex items-center justify-center shrink-0 mt-0.5',
                          isInteresting ? 'bg-amber-500/10' : 'bg-emerald-500/10'
                        )}>
                          <Icon name={isInteresting ? 'sparkles' : 'check'} size={10} className={cn(isInteresting ? 'text-amber-500' : 'text-emerald-500')} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="text-[13px] leading-5 text-foreground truncate">{citation.title}</p>
                            <span className={cn(
                              'text-[10px] px-1.5 py-0.5 rounded border shrink-0',
                              isInteresting ? 'text-amber-700 border-amber-500/30 bg-amber-500/10 dark:text-amber-300' : 'text-emerald-700 border-emerald-500/30 bg-emerald-500/10 dark:text-emerald-300'
                            )}>
                              {isInteresting ? 'Repéré' : 'Utilisé'}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground min-w-0">
                            <span className="truncate">{citation.url || citation.source}</span>
                            <span className="shrink-0">•</span>
                            <span className="shrink-0">{formatRelativeTime(citation.timestamp)}</span>
                          </div>
                          {citation.reason && (
                            <p className="text-[11px] leading-4 text-muted-foreground mt-0.5 line-clamp-1">{citation.reason}</p>
                          )}
                          {citation.snippet && (
                            <p className="text-[11px] leading-4 text-foreground/90 line-clamp-2 mt-0.5">{citation.snippet}</p>
                          )}
                        </div>
                      </div>
                       <div className="mt-1 flex items-center gap-1">
                        {citation.url && (
                          <button
                            onClick={() => openUrl(citation.url!)}
                            title="Ouvrir la source"
                            className="p-1 rounded border border-border hover:bg-accent transition-colors"
                          >
                            <Icon name="external-link" size={12} className="text-muted-foreground" />
                          </button>
                        )}
                        <button
                          onClick={() => goToMessage(citation.messageId)}
                          title="Voir dans la réponse"
                          className="p-1 rounded border border-border hover:bg-accent transition-colors"
                        >
                          <Icon name="message-square" size={12} className="text-muted-foreground" />
                        </button>
                        {citation.snippet && (
                          <button
                            onClick={() => copyCitationSnippet(citation.snippet)}
                            title="Copier l'extrait"
                            className="p-1 rounded border border-border hover:bg-accent transition-colors"
                          >
                            <Icon name="copy" size={12} className="text-muted-foreground" />
                          </button>
                        )}
                        <button
                          onClick={() => removeCitation(citation.id)}
                          title="Supprimer"
                          className="p-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ml-auto"
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </div>
                    </div>
                  );
                }) : (
                  <div className="text-center py-6 border border-dashed border-border rounded-lg">
                    <p className="text-sm text-muted-foreground">Aucun résultat pour ce filtre</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8">
                <Icon name="book-open" size={32} className="text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">
                  Aucun passage marqué
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
