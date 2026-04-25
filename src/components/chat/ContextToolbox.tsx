import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/useChatStore';
import { useCitationsStore } from '../../stores/useCitationsStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { useToolsStore } from '../../stores/useToolsStore';
import { extractDomain, fetchWebPage, getFaviconUrl } from '../../services/webSearch';
import { getWebSearchSettings } from '../../services/webSearchSettings';
import { compareLocalized, formatRelativeTimeShort } from '../../i18n/format';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';

interface ContextToolboxProps {
  className?: string;
}

type ToolboxTab = 'context' | 'tools' | 'sources';
type SourceFilter = 'all' | 'interesting' | 'used';
type SourceSort = 'recent' | 'title' | 'source';

const readFile = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

export const ContextToolbox: React.FC<ContextToolboxProps> = ({ className }) => {
  const { t, i18n } = useTranslation();
  const { selectedConversationId, createConversation } = useChatStore();
  const { getChatModeTools, isChatToolEnabled, toggleChatTool, mcpServers } = useToolsStore();
  const {
    getConversationContextCitations,
    getConversationInterestingSourceCitations,
    getConversationUsedSourceCitations,
    addCitation,
    removeCitation,
  } = useCitationsStore();
  const nativeToolsSupported = useProviderStore((state) => state.selectedSupportsNativeToolCalling());

  const [activeTab, setActiveTab] = useState<ToolboxTab>('context');
  const [isDragging, setIsDragging] = useState(false);
  const [isAddingUrl, setIsAddingUrl] = useState(false);
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceSort, setSourceSort] = useState<SourceSort>('recent');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const locale = i18n.resolvedLanguage || i18n.language;
  const webSearchSettings = getWebSearchSettings();
  const hasSelectedWebSearchKey =
    webSearchSettings.provider === 'tavily'
      ? webSearchSettings.tavilyApiKey.trim().length > 0
      : webSearchSettings.braveApiKey.trim().length > 0;

  const contextCitations = useMemo(
    () =>
      selectedConversationId
        ? getConversationContextCitations(selectedConversationId)
        : [],
    [getConversationContextCitations, selectedConversationId]
  );
  const interestingSourceCitations = useMemo(
    () =>
      selectedConversationId
        ? getConversationInterestingSourceCitations(selectedConversationId)
        : [],
    [getConversationInterestingSourceCitations, selectedConversationId]
  );
  const usedSourceCitations = useMemo(
    () =>
      selectedConversationId
        ? getConversationUsedSourceCitations(selectedConversationId)
        : [],
    [getConversationUsedSourceCitations, selectedConversationId]
  );
  const fileCitations = contextCitations.filter((citation) => citation.type !== 'web');
  const webCitations = contextCitations.filter((citation) => citation.type === 'web');
  const sourceCitations = useMemo(
    () => [...interestingSourceCitations, ...usedSourceCitations],
    [interestingSourceCitations, usedSourceCitations]
  );
  const sourceCount = useMemo(
    () =>
      new Set(
        sourceCitations
          .map((citation) => citation.url || citation.source || citation.title)
          .filter(Boolean)
      ).size,
    [sourceCitations]
  );
  const chatTools = getChatModeTools();
  const onlineMcpServers = mcpServers.filter((server) => server.status === 'online');

  const tabs: Array<{ id: ToolboxTab; label: string; icon: IconName }> = [
    { id: 'context', label: t('chat.contextToolbox.tabs.context', 'Context'), icon: 'paperclip' },
    { id: 'tools', label: t('chat.contextToolbox.tabs.tools', 'Tools'), icon: 'tool' },
    { id: 'sources', label: t('chat.contextToolbox.tabs.sources', 'Sources'), icon: 'file-text' },
  ];

  useEffect(() => {
    if (isAddingUrl) urlInputRef.current?.focus();
  }, [isAddingUrl]);

  const ensureConversation = useCallback(async () => {
    if (selectedConversationId) return selectedConversationId;
    const conversation = await createConversation(t('chat.newChat', 'New Chat'), null, null);
    return conversation.id;
  }, [createConversation, selectedConversationId, t]);

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const conversationId = await ensureConversation();
    for (const file of files) {
      try {
        const content = await readFile(file);
        addCitation({
          type: 'file',
          scope: 'context',
          source: file.name,
          title: file.name,
          snippet: content.slice(0, 1000) + (content.length > 1000 ? '...' : ''),
          path: file.name,
          messageId: `manual-${Date.now()}`,
          conversationId,
        });
      } catch (error) {
        console.error('Failed to read file:', error);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [addCitation, ensureConversation]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (activeTab !== 'context') return;
    event.preventDefault();
    setIsDragging(true);
  }, [activeTab]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    void handleFileSelect(event.dataTransfer.files);
  }, [handleFileSelect]);

  const handleAddUrl = async () => {
    const raw = urlInput.trim();
    const normalizedUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!raw) {
      setUrlError(t('chat.enterUrl', 'Enter a URL.'));
      return;
    }
    try {
      const parsed = new URL(normalizedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid');
    } catch {
      setUrlError(t('chat.invalidUrl', 'Invalid URL'));
      return;
    }
    const conversationId = await ensureConversation();
    setIsFetchingUrl(true);
    try {
      if (getWebSearchSettings().fetchEnabled) {
        const fetched = await fetchWebPage(normalizedUrl);
        addCitation({
          type: 'web',
          scope: 'context',
          source: fetched.url,
          title: fetched.title,
          snippet: fetched.snippet,
          url: fetched.url,
          messageId: `manual-${Date.now()}`,
          conversationId,
        });
      } else {
        addCitation({
          type: 'web',
          scope: 'context',
          source: normalizedUrl,
          title: extractDomain(normalizedUrl),
          url: normalizedUrl,
          messageId: `manual-${Date.now()}`,
          conversationId,
        });
      }
      setIsAddingUrl(false);
      setUrlInput('');
      setUrlError('');
    } catch (error) {
      console.error('Failed to fetch URL preview:', error);
      addCitation({
        type: 'web',
        scope: 'context',
        source: normalizedUrl,
        title: extractDomain(normalizedUrl),
        url: normalizedUrl,
        messageId: `manual-${Date.now()}`,
        conversationId,
      });
      setIsAddingUrl(false);
      setUrlInput('');
      setUrlError('');
    } finally {
      setIsFetchingUrl(false);
    }
  };

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const conversationId = await ensureConversation();
      addCitation({
        type: 'document',
        scope: 'context',
        source: t('chat.contextToolbox.clipboard', 'Clipboard'),
        title: t('chat.contextToolbox.clipboardText', 'Clipboard text'),
        snippet: text.slice(0, 1000) + (text.length > 1000 ? '...' : ''),
        messageId: `manual-${Date.now()}`,
        conversationId,
      });
    } catch (error) {
      console.error('Failed to read clipboard:', error);
    }
  }, [addCitation, ensureConversation, t]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleStartAddingUrl = useCallback(() => {
    setIsAddingUrl(true);
    setUrlError('');
  }, []);

  const filteredSourceCitations = useMemo(() => {
    const query = sourceSearch.trim().toLowerCase();
    return [...sourceCitations]
      .filter((citation) => {
        const kind = citation.kind || 'used';
        if (sourceFilter !== 'all' && kind !== sourceFilter) return false;
        if (!query) return true;
        return [citation.title, citation.snippet, citation.source, citation.url, citation.reason]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(query));
      })
      .sort((left, right) => {
        if (sourceSort === 'recent') {
          return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
        }
        if (sourceSort === 'title') {
          return compareLocalized(left.title, right.title, locale);
        }
        return compareLocalized(left.url || left.source || '', right.url || right.source || '', locale);
      });
  }, [locale, sourceCitations, sourceFilter, sourceSearch, sourceSort]);

  const renderToolTooltip = (toolId: string) => {
    if (toolId === 'web_search' && !hasSelectedWebSearchKey) {
      return t('chat.contextToolbox.webSearchKeyTooltip', 'Add an API key in Settings > Tools > Web Search');
    }
    if (!nativeToolsSupported) {
      return t('chat.contextToolbox.nativeToolTooltip', 'The selected model does not support native tool calls.');
    }
    return null;
  };

  return (
    <aside
      className={cn('h-full w-full bg-card border-l border-border flex flex-col', className)}
      data-tour-id="chat-toolbox-panel"
      onDragOver={handleDragOver}
      onDragLeave={(event) => { event.preventDefault(); setIsDragging(false); }}
      onDrop={handleDrop}
    >
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="layout-grid" size={16} className="text-primary" />
          {t('chat.toolbox', 'Toolbox')}
        </h1>
      </div>
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => void handleFileSelect(event.target.files)} />
      <div className="h-10 border-b border-border flex items-center px-2 gap-1" data-tour-id="chat-toolbox-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-all duration-200',
              activeTab === tab.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            <Icon name={tab.icon} size={12} />
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4 relative">
        {isDragging && activeTab === 'context' && (
          <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary/50 m-4 rounded-lg flex items-center justify-center z-10 pointer-events-none">
            <div className="text-center">
              <Icon name="upload" size={24} className="text-primary mx-auto mb-2" />
              <p className="text-sm text-primary font-medium">{t('chat.contextToolbox.dropFilesHere', 'Drop files here')}</p>
            </div>
          </div>
        )}

        {activeTab === 'context' && (
          <div className="space-y-4">
            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('chat.contextToolbox.attachedFiles', 'Attached files')}</h3>
                <button onClick={() => fileInputRef.current?.click()} className="p-1 hover:bg-accent rounded transition-colors" title={t('chat.contextToolbox.upload', 'Upload')}>
                  <Icon name="plus" size={12} className="text-muted-foreground" />
                </button>
              </div>
              {fileCitations.length > 0 ? (
                <div className="space-y-2">
                  {fileCitations.map((citation) => (
                    <div key={citation.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border hover:bg-accent/50 transition-colors group">
                      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0"><Icon name="file" size={14} className="text-muted-foreground" /></div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{citation.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{citation.path || citation.source}</p>
                      </div>
                      <button onClick={() => removeCitation(citation.id)} className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity" title={t('common.delete', 'Delete')}>
                        <Icon name="x" size={12} className="text-muted-foreground" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <button className="w-full text-center py-6 border border-dashed border-border rounded-lg hover:bg-accent/50 transition-colors" onClick={() => fileInputRef.current?.click()}>
                  <Icon name="paperclip" size={24} className="text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">{t('chat.contextToolbox.dropFilesHere', 'Drop files here')}</p>
                </button>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2"><Icon name="link" size={12} />{t('chat.contextToolbox.addedLinks', 'Added links')}</h3>
                {webCitations.length > 0 && <span className="text-xs text-muted-foreground">{webCitations.length}</span>}
              </div>
              {webCitations.length > 0 ? (
                <div className="space-y-2">
                  {webCitations.map((citation) => (
                    <div key={citation.id} className="flex items-start gap-3 px-3 py-2 rounded-lg border border-border hover:bg-accent/50 transition-colors group">
                      <button onClick={() => citation.url && window.open(citation.url, '_blank', 'noopener,noreferrer')} className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden" title={t('chat.contextToolbox.openSource', 'Open source')}>
                        {citation.url ? <img src={getFaviconUrl(citation.url)} alt="" className="w-4 h-4" onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }} /> : <Icon name="globe" size={14} className="text-muted-foreground" />}
                      </button>
                      <button onClick={() => citation.url && window.open(citation.url, '_blank', 'noopener,noreferrer')} className="flex-1 min-w-0 text-left" title={t('chat.contextToolbox.openSource', 'Open source')}>
                        <p className="text-sm text-foreground truncate group-hover:text-primary transition-colors">{citation.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{citation.url || citation.source}</p>
                      </button>
                      <button onClick={() => removeCitation(citation.id)} className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity" title={t('common.delete', 'Delete')}>
                        <Icon name="x" size={12} className="text-muted-foreground" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 border border-dashed border-border rounded-lg">
                  <Icon name="link" size={24} className="text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">{t('chat.contextToolbox.noLinksAdded', 'No links added')}</p>
                </div>
              )}
            </section>

            <section>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{t('chat.contextToolbox.quickActions', 'Quick actions')}</h3>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleUploadClick}
                  data-tour-id="chat-context-upload"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors min-w-0"
                >
                  <Icon name="upload" size={14} className="text-muted-foreground" />
                  <span className="truncate">{t('chat.contextToolbox.upload', 'Upload')}</span>
                </button>
                <button
                  onClick={handleStartAddingUrl}
                  data-tour-id="chat-context-add-url"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors min-w-0"
                >
                  <Icon name="link" size={14} className="text-muted-foreground" />
                  <span className="truncate">{t('chat.contextToolbox.addUrl', 'Add URL')}</span>
                </button>
                <button
                  onClick={() => void handlePaste()}
                  data-tour-id="chat-context-paste"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-accent transition-colors min-w-0"
                >
                  <Icon name="clipboard" size={14} className="text-muted-foreground" />
                  <span className="truncate">{t('chat.contextToolbox.paste', 'Paste')}</span>
                </button>
                <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-foreground opacity-50 cursor-not-allowed min-w-0">
                  <Icon name="camera" size={14} className="text-muted-foreground" />
                  <span className="truncate">{t('chat.contextToolbox.screenshot', 'Screenshot')}</span>
                </button>
              </div>
              {isAddingUrl && (
                <div className="mt-2 p-3 rounded-lg border border-border bg-accent/20 space-y-2">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('chat.contextToolbox.addUrl', 'Add URL')}</label>
                  <div className="flex items-center gap-2">
                    <Input
                      ref={urlInputRef}
                      value={urlInput}
                      onChange={(event) => { setUrlInput(event.target.value); if (urlError) setUrlError(''); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); void handleAddUrl(); }
                        if (event.key === 'Escape') { event.preventDefault(); setIsAddingUrl(false); setUrlInput(''); setUrlError(''); }
                      }}
                      error={Boolean(urlError)}
                      placeholder={t('chat.contextToolbox.urlPlaceholder', 'https://example.com/article')}
                      className="h-9"
                    />
                    <button onClick={() => void handleAddUrl()} disabled={isFetchingUrl} className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
                      {isFetchingUrl ? t('chat.contextToolbox.fetching', 'Fetching...') : t('common.add', 'Add')}
                    </button>
                    <button onClick={() => { setIsAddingUrl(false); setUrlInput(''); setUrlError(''); }} className="h-9 px-3 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                      {t('common.cancel', 'Cancel')}
                    </button>
                  </div>
                  {urlError && <p className="text-xs text-red-500">{urlError}</p>}
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'tools' && (
          <div className="space-y-4">
            {!nativeToolsSupported && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t('chat.contextToolbox.toolsUnavailableWarning', 'Tools are unavailable for the currently selected provider or model. Select a model with native tool calling support to enable them.')}</div>}
            <section>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{t('chat.contextToolbox.builtInTools', 'Built-in Tools')}</h3>
              <div className="space-y-1">
                {chatTools.length > 0 ? chatTools.map((tool) => {
                  const tooltip = renderToolTooltip(tool.id);
                  const disabled = Boolean(tooltip);
                  return (
                    <div key={tool.id} className={cn('relative group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors', disabled && 'opacity-50')}>
                      <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Icon name={tool.icon as any} size={12} className="text-primary" /></div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground">{tool.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{tool.description}</p>
                      </div>
                      <Switch checked={isChatToolEnabled(tool.id)} disabled={disabled} onCheckedChange={() => { if (!disabled) toggleChatTool(tool.id); }} />
                      {tooltip && <div className="pointer-events-none absolute -top-2 right-2 hidden group-hover:block z-10"><div className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-md whitespace-nowrap">{tooltip}</div></div>}
                    </div>
                  );
                }) : <p className="text-sm text-muted-foreground text-center py-4">{t('chat.contextToolbox.noToolsEnabled', 'No tools enabled')}</p>}
              </div>
            </section>
            <section>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{t('chat.contextToolbox.mcpServers', 'MCP Servers')}</h3>
              <div className="space-y-1">
                {onlineMcpServers.length > 0 ? onlineMcpServers.map((server) => (
                  <div key={server.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent transition-colors">
                    <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center shrink-0"><Icon name={server.icon as any} size={12} className="text-muted-foreground" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground">{server.name}</p>
                      <p className="text-xs text-muted-foreground">{server.category}</p>
                    </div>
                    <span className={cn('w-2 h-2 rounded-full shrink-0', server.status === 'online' ? 'bg-emerald-500' : server.status === 'degraded' ? 'bg-amber-500' : 'bg-muted')} />
                  </div>
                )) : <p className="text-sm text-muted-foreground text-center py-4">{t('chat.contextToolbox.noMcpServers', 'No MCP servers connected')}</p>}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'sources' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2"><Icon name="book-open" size={12} />{t('chat.contextToolbox.tabs.sources', 'Sources')}</h3>
              <span className="text-xs text-muted-foreground">{t('chat.contextToolbox.sourceSummary', '{{interesting}} found • {{used}} used • {{total}} sources', { interesting: interestingSourceCitations.length, used: usedSourceCitations.length, total: sourceCount })}</span>
            </div>
            {!isChatToolEnabled('mark_source_passage') && <div className="rounded-md border border-muted bg-muted/50 px-2.5 py-1.5"><p className="text-[11px] text-muted-foreground"><span className="font-medium">{t('chat.contextToolbox.collectionDisabledTitle', 'Collection disabled')}</span> {t('chat.contextToolbox.collectionDisabledDescription', 'Enable the Sources tool to save new passages.')}</p></div>}
            <div className="space-y-2">
              <Input value={sourceSearch} onChange={(event) => setSourceSearch(event.target.value)} placeholder={t('chat.contextToolbox.sourceSearchPlaceholder', 'Search sources')} className="h-9" />
              <div className="flex items-center gap-2">
                {[
                  { key: 'all' as SourceFilter, label: t('common.all', 'All'), active: 'bg-primary/10 text-primary border-primary/30' },
                  { key: 'interesting' as SourceFilter, label: t('chat.contextToolbox.found', 'Found'), active: 'bg-amber-500/10 text-amber-600 border-amber-500/30' },
                  { key: 'used' as SourceFilter, label: t('chat.contextToolbox.used', 'Used'), active: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' },
                ].map((option) => (
                  <button key={option.key} onClick={() => setSourceFilter(option.key)} className={cn('px-2.5 py-1 text-xs rounded-md border transition-colors', sourceFilter === option.key ? option.active : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent')}>
                    {option.label}
                  </button>
                ))}
                <select value={sourceSort} onChange={(event) => setSourceSort(event.target.value as SourceSort)} className="ml-auto shrink-0 h-8 w-auto rounded-md border border-border bg-card pl-2 pr-7 text-xs text-muted-foreground">
                  <option value="recent">{t('chat.contextToolbox.sortRecent', 'Most recent')}</option>
                  <option value="title">{t('chat.contextToolbox.sortTitle', 'Title')}</option>
                  <option value="source">{t('chat.contextToolbox.sortSource', 'Source')}</option>
                </select>
              </div>
            </div>
            {sourceCitations.length > 0 ? (
              <div className="space-y-2">
                {filteredSourceCitations.length > 0 ? filteredSourceCitations.map((citation) => {
                  const kind = citation.kind || 'used';
                  const isInteresting = kind === 'interesting';
                  return (
                    <div key={citation.id} className={cn('rounded-lg border px-2.5 py-1.5 transition-colors hover:bg-accent/50', isInteresting ? 'border-amber-500/20 bg-amber-500/5' : 'border-emerald-500/20 bg-emerald-500/5')}>
                      <div className="flex items-start gap-1.5">
                        <div className={cn('w-5 h-5 rounded flex items-center justify-center shrink-0 mt-0.5', isInteresting ? 'bg-amber-500/10' : 'bg-emerald-500/10')}>
                          <Icon name={isInteresting ? 'sparkles' : 'check'} size={10} className={cn(isInteresting ? 'text-amber-500' : 'text-emerald-500')} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="text-[13px] leading-5 text-foreground truncate">{citation.title}</p>
                            <span className={cn('text-[10px] px-1.5 py-0.5 rounded border shrink-0', isInteresting ? 'text-amber-700 border-amber-500/30 bg-amber-500/10 dark:text-amber-300' : 'text-emerald-700 border-emerald-500/30 bg-emerald-500/10 dark:text-emerald-300')}>
                              {isInteresting ? t('chat.contextToolbox.found', 'Found') : t('chat.contextToolbox.used', 'Used')}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground min-w-0">
                            <span className="truncate">{citation.url || citation.source}</span>
                            <span className="shrink-0">•</span>
                            <span className="shrink-0">{formatRelativeTimeShort(citation.timestamp, Date.now(), locale)}</span>
                          </div>
                          {citation.reason && <p className="text-[11px] leading-4 text-muted-foreground mt-0.5 line-clamp-1">{citation.reason}</p>}
                          {citation.snippet && <p className="text-[11px] leading-4 text-foreground/90 line-clamp-2 mt-0.5">{citation.snippet}</p>}
                        </div>
                      </div>
                      <div className="mt-1 flex items-center gap-1">
                        {citation.url && <button onClick={() => window.open(citation.url!, '_blank', 'noopener,noreferrer')} title={t('chat.contextToolbox.openSource', 'Open source')} className="p-1 rounded border border-border hover:bg-accent transition-colors"><Icon name="external-link" size={12} className="text-muted-foreground" /></button>}
                        <button onClick={() => window.dispatchEvent(new CustomEvent('macro:focus-message', { detail: { messageId: citation.messageId } }))} title={t('chat.contextToolbox.viewInResponse', 'View in response')} className="p-1 rounded border border-border hover:bg-accent transition-colors"><Icon name="message-square" size={12} className="text-muted-foreground" /></button>
                        {citation.snippet && <button onClick={() => navigator.clipboard.writeText(citation.snippet!).catch(() => undefined)} title={t('chat.contextToolbox.copySnippet', 'Copy snippet')} className="p-1 rounded border border-border hover:bg-accent transition-colors"><Icon name="copy" size={12} className="text-muted-foreground" /></button>}
                        <button onClick={() => removeCitation(citation.id)} title={t('common.delete', 'Delete')} className="p-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ml-auto"><Icon name="trash" size={12} /></button>
                      </div>
                    </div>
                  );
                }) : <div className="text-center py-6 border border-dashed border-border rounded-lg"><p className="text-sm text-muted-foreground">{t('chat.contextToolbox.noSourceResults', 'No results for this filter')}</p></div>}
              </div>
            ) : (
              <div className="text-center py-8">
                <Icon name="book-open" size={32} className="text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">{t('chat.contextToolbox.noPassagesMarked', 'No marked passages')}</p>
                <p className="text-xs text-muted-foreground/70 mt-1">{t('chat.contextToolbox.noPassagesMarkedDescription', 'Passages appear here when the AI calls the source-marking tool.')}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

export default ContextToolbox;
