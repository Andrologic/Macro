import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useCitationsStore } from '../../stores/useCitationsStore';
import type { Citation } from '../../stores/useCitationsStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { useToolsStore } from '../../stores/useToolsStore';
import { extractDomain, fetchWebPage, getFaviconUrl } from '../../services/webSearch';
import { getWebSearchSettings } from '../../services/webSearchSettings';
import { isProjectActionable } from '../../services/globalProjects';
import { compareLocalized, formatRelativeTimeShort } from '../../i18n/format';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { notify } from '../ui/toastService';

interface ContextToolboxProps {
  className?: string;
}

type ToolboxTab = 'context' | 'tools' | 'sources';
type SourceFilter = 'all' | 'interesting' | 'used';
type SourceSort = 'recent' | 'title' | 'source';

const ACCEPTED_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'log',
  'env',
  'toml',
  'ini',
  'conf',
]);
const ACCEPTED_FILE_TYPES = [
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.yaml',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.ts',
  '.py',
  '.sql',
  '.log',
];
const ACCEPTED_FILE_TYPES_LABEL = ACCEPTED_FILE_TYPES.join(', ');

const isSupportedTextFile = (file: File): boolean => {
  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith('text/')) return true;
  if (
    [
      'application/json',
      'application/xml',
      'application/x-ndjson',
      'application/javascript',
      'application/x-javascript',
      'application/yaml',
      'application/x-yaml',
    ].includes(mimeType)
  ) return true;

  const extension = file.name.split('.').pop()?.toLowerCase();
  return Boolean(extension && ACCEPTED_TEXT_EXTENSIONS.has(extension));
};

const readFile = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

const createManualMessageId = (): string =>
  `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const formatByteSize = (value?: number): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
};

export const ContextToolbox: React.FC<ContextToolboxProps> = ({ className }) => {
  const { t, i18n } = useTranslation();
  const {
    conversations,
    selectedConversationId,
    createConversation,
    setChatConversationWorkspace,
    composerContextRefs,
    addComposerContextRef,
    removeComposerContextRef,
  } = useChatStore();
  const standaloneProjects = useAppStore((state) => state.standaloneProjects ?? []);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const { getChatModeTools, isChatToolEnabled, toggleChatTool } = useToolsStore();
  const citations = useCitationsStore((state) => state.citations);
  const addCitation = useCitationsStore((state) => state.addCitation);
  const removeCitation = useCitationsStore((state) => state.removeCitation);
  const nativeToolsSupported = useProviderStore((state) => state.selectedSupportsNativeToolCalling());

  const [activeTab, setActiveTab] = useState<ToolboxTab>('context');
  const [isDragging, setIsDragging] = useState(false);
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceSort, setSourceSort] = useState<SourceSort>('recent');
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<string>>(() => new Set());
  const [failedFaviconUrls, setFailedFaviconUrls] = useState<Set<string>>(() => new Set());
  const [isUpdatingWorkspace, setIsUpdatingWorkspace] = useState(false);
  const [contextConversationId, setContextConversationId] = useState<string | null>(
    selectedConversationId
  );
  const [lastAddedContextCitationId, setLastAddedContextCitationId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const locale = i18n.resolvedLanguage || i18n.language;
  const webSearchSettings = getWebSearchSettings();
  const hasSelectedWebSearchKey =
    webSearchSettings.provider === 'tavily'
      ? webSearchSettings.hasTavilySecret
      : webSearchSettings.hasBraveSecret;
  const effectiveConversationId = selectedConversationId ?? contextConversationId;
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === effectiveConversationId) ?? null,
    [conversations, effectiveConversationId]
  );
  const agentWorkspaceOptions = useMemo(() => {
    const standaloneOptions = standaloneProjects
      .filter(isProjectActionable)
      .map((project) => ({
        value: `project:${project.id}`,
        label: project.name,
        groupId: null,
        projectId: project.id,
      }));
    const groupOptions = projectGroups.flatMap((group) => {
      const actionableProjects = group.projects.filter(isProjectActionable);
      if (actionableProjects.length === 0) return [];
      const persistedFocus = activeConversation?.project_id
        ? actionableProjects.find((project) => project.id === activeConversation.project_id) ?? null
        : null;
      return [{
        value: `group:${group.id}`,
        label: `${group.name} (${actionableProjects.length})`,
        groupId: group.id,
        projectId: persistedFocus?.id ?? actionableProjects[0]!.id,
      }];
    });
    return [...standaloneOptions, ...groupOptions];
  }, [activeConversation, projectGroups, standaloneProjects]);
  const selectedAgentWorkspaceValue = activeConversation?.group_id
    ? `group:${activeConversation.group_id}`
    : activeConversation?.project_id
      ? `project:${activeConversation.project_id}`
      : 'none';
  const hasAgentWorkspace = agentWorkspaceOptions.some(
    (option) => option.value === selectedAgentWorkspaceValue
  );

  const contextCitations = useMemo(
    () =>
      effectiveConversationId
        ? citations.filter(
            (citation) =>
              citation.conversationId === effectiveConversationId &&
              citation.scope === 'context'
          )
        : [],
    [citations, effectiveConversationId]
  );
  const sourceCitations = useMemo(
    () =>
      effectiveConversationId
        ? citations
            .filter(
              (citation) =>
                citation.conversationId === effectiveConversationId &&
                citation.scope === 'source'
            )
            .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
        : [],
    [citations, effectiveConversationId]
  );
  const fileCitations = useMemo(
    () => contextCitations.filter((citation) => citation.type === 'file'),
    [contextCitations]
  );
  const documentCitations = useMemo(
    () => contextCitations.filter((citation) => citation.type === 'document'),
    [contextCitations]
  );
  const webCitations = useMemo(
    () => contextCitations.filter((citation) => citation.type === 'web'),
    [contextCitations]
  );
  const contextCount = contextCitations.length;
  const interestingSourceCitations = useMemo(
    () => sourceCitations.filter((citation) => (citation.kind || 'used') === 'interesting'),
    [sourceCitations]
  );
  const usedSourceCitations = useMemo(
    () => sourceCitations.filter((citation) => (citation.kind || 'used') === 'used'),
    [sourceCitations]
  );
  const sourcePassageCount = sourceCitations.length;
  const chatTools = getChatModeTools();

  const tabs: Array<{ id: ToolboxTab; label: string; icon: IconName; count?: number }> = [
    { id: 'context', label: t('chat.contextToolbox.tabs.context', 'Context'), icon: 'paperclip', count: contextCount },
    { id: 'tools', label: t('chat.contextToolbox.tabs.tools', 'Tools'), icon: 'tool', count: chatTools.length },
    { id: 'sources', label: t('chat.contextToolbox.tabs.sources', 'Sources'), icon: 'file-text', count: sourcePassageCount },
  ];

  useEffect(() => {
    if (selectedConversationId) {
      setContextConversationId(selectedConversationId);
    }
  }, [selectedConversationId]);

  const ensureConversation = useCallback(async () => {
    if (selectedConversationId) {
      setContextConversationId(selectedConversationId);
      return selectedConversationId;
    }
    const conversation = await createConversation(t('chat.newChat', 'New Chat'), null, null);
    setContextConversationId(conversation.id);
    return conversation.id;
  }, [createConversation, selectedConversationId, t]);

  const handleAgentWorkspaceChange = useCallback(async (value: string) => {
    const selectedWorkspace = agentWorkspaceOptions.find((option) => option.value === value) ?? null;
    setIsUpdatingWorkspace(true);
    try {
      const conversationId = await ensureConversation();
      await setChatConversationWorkspace(conversationId, {
        groupId: selectedWorkspace?.groupId ?? null,
        projectId: selectedWorkspace?.projectId ?? null,
      });
    } catch (error) {
      notify.error(
        t('chat.contextToolbox.workspaceUpdateFailed', 'Unable to change the agent workspace'),
        {
          description: error instanceof Error ? error.message : String(error),
        }
      );
    } finally {
      setIsUpdatingWorkspace(false);
    }
  }, [agentWorkspaceOptions, ensureConversation, setChatConversationWorkspace, t]);

  const addContextCitationAndReveal = useCallback(async (
    citationData: Omit<Citation, 'id' | 'timestamp' | 'conversationId' | 'messageId' | 'scope'> & {
      messageId?: string;
    },
    conversationIdOverride?: string,
  ) => {
    const conversationId = conversationIdOverride ?? await ensureConversation();
    setContextConversationId(conversationId);
    const citationId = addCitation({
      ...citationData,
      scope: 'context',
      messageId: citationData.messageId ?? createManualMessageId(),
      conversationId,
    });
    setActiveTab('context');
    setLastAddedContextCitationId(citationId);
    return { citationId, conversationId };
  }, [addCitation, ensureConversation]);

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setActiveTab('context');
    const supportedFiles = Array.from(files).filter((file) => {
      if (!isSupportedTextFile(file)) {
        notify.error(
          t('chat.contextToolbox.unsupportedFileType', 'Unsupported file type'),
          {
            description: t(
              'chat.contextToolbox.supportedTextFileTypes',
              'Only text-based files are supported: {{formats}}.',
              { formats: ACCEPTED_FILE_TYPES_LABEL }
            ),
          }
        );
        return false;
      }
      return true;
    });
    if (supportedFiles.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const conversationId = await ensureConversation();
    for (const file of supportedFiles) {
      try {
        const content = await readFile(file);
        await addContextCitationAndReveal({
          type: 'file',
          source: file.name,
          title: file.name,
          snippet: content.slice(0, 1000) + (content.length > 1000 ? '...' : ''),
          content,
          path: file.name,
          sizeBytes: file.size,
        }, conversationId);
      } catch (error) {
        console.error('Failed to read file:', error);
        notify.error(
          t('chat.contextToolbox.fileReadFailedTitle', 'Could not read file'),
          {
            description: file.name,
          }
        );
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [addContextCitationAndReveal, ensureConversation, t]);

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
    setActiveTab('context');
    setIsFetchingUrl(true);
    try {
      if (getWebSearchSettings().fetchEnabled) {
        const fetched = await fetchWebPage(normalizedUrl);
        await addContextCitationAndReveal({
          type: 'web',
          source: fetched.url,
          title: fetched.title,
          snippet: fetched.snippet,
          content: fetched.content,
          url: fetched.url,
          favicon: fetched.favicon,
        }, conversationId);
      } else {
        await addContextCitationAndReveal({
          type: 'web',
          source: normalizedUrl,
          title: extractDomain(normalizedUrl),
          url: normalizedUrl,
        }, conversationId);
      }
      setUrlInput('');
      setUrlError('');
      window.setTimeout(() => urlInputRef.current?.focus(), 0);
    } catch (error) {
      console.error('Failed to fetch URL preview:', error);
      notify.error(
        t('chat.contextToolbox.urlPreviewFailedTitle', 'Could not fetch URL preview'),
        {
          description: normalizedUrl,
        }
      );
      await addContextCitationAndReveal({
        type: 'web',
        source: normalizedUrl,
        title: extractDomain(normalizedUrl),
        url: normalizedUrl,
      }, conversationId);
      setUrlInput('');
      setUrlError('');
      window.setTimeout(() => urlInputRef.current?.focus(), 0);
    } finally {
      setIsFetchingUrl(false);
    }
  };

  const handleFaviconError = useCallback((src: string) => {
    setFailedFaviconUrls((current) => {
      if (current.has(src)) return current;
      const next = new Set(current);
      next.add(src);
      return next;
    });
  }, []);

  const handlePaste = useCallback(async () => {
    setActiveTab('context');
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        notify.error(t('chat.contextToolbox.clipboardEmptyTitle', 'Clipboard is empty'));
        return;
      }
      const conversationId = await ensureConversation();
      await addContextCitationAndReveal({
        type: 'document',
        source: t('chat.contextToolbox.clipboard', 'Clipboard'),
        title: t('chat.contextToolbox.clipboardText', 'Clipboard text'),
        snippet: text.slice(0, 1000) + (text.length > 1000 ? '...' : ''),
        content: text,
      }, conversationId);
    } catch (error) {
      console.error('Failed to read clipboard:', error);
      notify.error(t('chat.contextToolbox.clipboardReadFailedTitle', 'Could not read clipboard'));
    }
  }, [addContextCitationAndReveal, ensureConversation, t]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
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

  const toggleSourceExpansion = useCallback((citationId: string) => {
    setExpandedSourceIds((previous) => {
      const next = new Set(previous);
      if (next.has(citationId)) {
        next.delete(citationId);
      } else {
        next.add(citationId);
      }
      return next;
    });
  }, []);

  const handleAddSourceToComposer = useCallback((citation: Citation) => {
    addComposerContextRef({
      id: citation.id,
      kind: 'source',
      title: citation.title,
      subtitle: citation.source,
      data: citation,
    });
  }, [addComposerContextRef]);

  const handleRemoveSourceCitation = useCallback((citationId: string) => {
    removeCitation(citationId);
    removeComposerContextRef(citationId, 'source');
    setExpandedSourceIds((previous) => {
      if (!previous.has(citationId)) return previous;
      const next = new Set(previous);
      next.delete(citationId);
      return next;
    });
  }, [removeCitation, removeComposerContextRef]);

  const renderToolTooltip = (toolId: string) => {
    if (toolId === 'web_search' && !hasSelectedWebSearchKey) {
      return t('chat.contextToolbox.webSearchKeyTooltip', 'Add an API key in Settings > Tools > Web Search');
    }
    if (toolId === 'web_fetch' && !webSearchSettings.fetchEnabled) {
      return t('chat.contextToolbox.webFetchDisabledTooltip', 'Enable Web Fetch in Settings > Tools > Web Search');
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
            {typeof tab.count === 'number' && tab.count > 0 && (
              <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                {tab.count}
              </span>
            )}
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
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('chat.contextToolbox.attachedFiles', 'Attached files')}</h3>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">{fileCitations.length}</span>
                </div>
                <button
                  onClick={handleUploadClick}
                  data-tour-id="chat-context-upload"
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-accent transition-colors"
                >
                  <Icon name="upload" size={13} className="text-muted-foreground" />
                  {t('chat.contextToolbox.upload', 'Upload')}
                </button>
              </div>
              {fileCitations.length > 0 ? (
                <div className="space-y-2">
                  {fileCitations.map((citation) => {
                    const sizeLabel = formatByteSize(citation.sizeBytes);
                    const metadata = [
                      sizeLabel,
                      formatRelativeTimeShort(citation.timestamp, Date.now(), locale),
                    ].filter(Boolean);
                    return (
                      <div
                        key={citation.id}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-accent/50',
                          citation.id === lastAddedContextCitationId && 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
                        )}
                      >
                        <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                          <Icon name="file" size={14} className="text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground truncate">{citation.title}</p>
                          <p className="text-xs text-muted-foreground truncate">{metadata.join(' • ')}</p>
                        </div>
                        <button
                          onClick={() => removeCitation(citation.id)}
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          title={t('chat.contextToolbox.removeFromContext', 'Remove from context')}
                          aria-label={t('chat.contextToolbox.removeFromContext', 'Remove from context')}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <button className="w-full rounded-lg border border-dashed border-border px-3 py-5 text-center hover:bg-accent/50 transition-colors" onClick={handleUploadClick}>
                  <Icon name="paperclip" size={22} className="text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">{t('chat.contextToolbox.dropFilesOrClick', 'Drop files here or click to add')}</p>
                </button>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2"><Icon name="link" size={12} />{t('chat.contextToolbox.addedLinks', 'Added links')}</h3>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">{webCitations.length}</span>
                </div>
              </div>
              <div data-tour-id="chat-context-add-url" className="rounded-lg border border-border bg-accent/20 p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    ref={urlInputRef}
                    value={urlInput}
                    onChange={(event) => { setUrlInput(event.target.value); if (urlError) setUrlError(''); }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); void handleAddUrl(); }
                      if (event.key === 'Escape') { event.preventDefault(); setUrlInput(''); setUrlError(''); }
                    }}
                    error={Boolean(urlError)}
                    placeholder={t('chat.contextToolbox.urlPlaceholder', 'https://example.com/article')}
                    className="h-9 min-w-0 flex-1"
                  />
                  <button onClick={() => void handleAddUrl()} disabled={isFetchingUrl} className="h-9 shrink-0 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 transition-colors">
                    {isFetchingUrl ? t('chat.contextToolbox.fetching', 'Fetching...') : t('common.add', 'Add')}
                  </button>
                </div>
                {urlError && <p className="text-xs text-red-500">{urlError}</p>}
              </div>
              {webCitations.length > 0 ? (
                <div className="space-y-2">
                  {webCitations.map((citation) => {
                    const metadata = [
                      citation.url ? extractDomain(citation.url) : citation.source,
                      formatRelativeTimeShort(citation.timestamp, Date.now(), locale),
                    ].filter(Boolean);
                    const faviconSrc = citation.favicon || (citation.url ? getFaviconUrl(citation.url) : '');
                    const showFavicon = faviconSrc && !failedFaviconUrls.has(faviconSrc);
                    return (
                      <div
                        key={citation.id}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-accent/50',
                          citation.id === lastAddedContextCitationId && 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
                        )}
                      >
                        <button onClick={() => citation.url && window.open(citation.url, '_blank', 'noopener,noreferrer')} className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0 overflow-hidden" title={t('chat.contextToolbox.openSource', 'Open source')}>
                          {showFavicon ? (
                            <img
                              src={faviconSrc}
                              alt=""
                              className="w-4 h-4"
                              onError={() => handleFaviconError(faviconSrc)}
                            />
                          ) : (
                            <Icon name="globe" size={14} className="text-muted-foreground" />
                          )}
                        </button>
                        <button onClick={() => citation.url && window.open(citation.url, '_blank', 'noopener,noreferrer')} className="flex-1 min-w-0 text-left" title={t('chat.contextToolbox.openSource', 'Open source')}>
                          <p className="text-sm text-foreground truncate hover:text-primary transition-colors">{citation.title}</p>
                          <p className="text-xs text-muted-foreground truncate">{metadata.join(' • ')}</p>
                        </button>
                        <button
                          onClick={() => removeCitation(citation.id)}
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          title={t('chat.contextToolbox.removeFromContext', 'Remove from context')}
                          aria-label={t('chat.contextToolbox.removeFromContext', 'Remove from context')}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-5 border border-dashed border-border rounded-lg">
                  <Icon name="link" size={22} className="text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">{t('chat.contextToolbox.noLinksAdded', 'No links added')}</p>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('chat.contextToolbox.pastedText', 'Pasted text')}</h3>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">{documentCitations.length}</span>
                </div>
                <button
                  onClick={() => void handlePaste()}
                  data-tour-id="chat-context-paste"
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-accent transition-colors"
                >
                  <Icon name="clipboard" size={13} className="text-muted-foreground" />
                  {t('chat.contextToolbox.paste', 'Paste')}
                </button>
              </div>
              {documentCitations.length > 0 ? (
                <div className="space-y-2">
                  {documentCitations.map((citation) => {
                    const metadata = [
                      formatRelativeTimeShort(citation.timestamp, Date.now(), locale),
                    ].filter(Boolean);
                    return (
                      <div
                        key={citation.id}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-accent/50',
                          citation.id === lastAddedContextCitationId && 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
                        )}
                      >
                        <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                          <Icon name="clipboard" size={14} className="text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground truncate">{citation.title}</p>
                          <p className="text-xs text-muted-foreground truncate">{metadata.join(' • ')}</p>
                        </div>
                        <button
                          onClick={() => removeCitation(citation.id)}
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          title={t('chat.contextToolbox.removeFromContext', 'Remove from context')}
                          aria-label={t('chat.contextToolbox.removeFromContext', 'Remove from context')}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-5 border border-dashed border-border rounded-lg">
                  <Icon name="clipboard" size={22} className="text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">{t('chat.contextToolbox.noPastedText', 'No pasted text added')}</p>
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'tools' && (
          <div className="space-y-4">
            {!nativeToolsSupported && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t('chat.contextToolbox.toolsUnavailableWarning', 'Tools are unavailable for the currently selected provider or model. Select a model with native tool calling support to enable them.')}</div>}
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <Icon name="folder" size={12} className="text-muted-foreground" />
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t('chat.contextToolbox.agentWorkspace', 'Agent workspace')}
                </h3>
              </div>
              <select
                value={selectedAgentWorkspaceValue}
                onChange={(event) => void handleAgentWorkspaceChange(event.target.value)}
                disabled={isUpdatingWorkspace}
                className="h-9 w-full rounded-md border border-border bg-card px-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary disabled:cursor-wait disabled:opacity-60"
                aria-label={t('chat.contextToolbox.agentWorkspace', 'Agent workspace')}
              >
                <option value="none">
                  {t('chat.contextToolbox.noAgentWorkspace', 'No workspace')}
                </option>
                {agentWorkspaceOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {hasAgentWorkspace
                  ? t(
                      'chat.contextToolbox.agentWorkspaceDescription',
                      'This workspace is attached as project context. It does not restrict the general terminal.'
                    )
                  : t(
                      'chat.contextToolbox.noAgentWorkspaceDescription',
                      'No project workspace is attached. The general terminal remains available when enabled.'
                    )}
              </p>
            </section>
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
          </div>
        )}

        {activeTab === 'sources' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2"><Icon name="book-open" size={12} />{t('chat.contextToolbox.tabs.sources', 'Sources')}</h3>
              <span className="text-xs text-muted-foreground">{t('chat.contextToolbox.sourceSummary', '{{interesting}} found • {{used}} used • {{total}} passages', { interesting: interestingSourceCitations.length, used: usedSourceCitations.length, total: sourcePassageCount })}</span>
            </div>
            {!isChatToolEnabled('mark_source_passage') && <div className="rounded-md border border-muted bg-muted/50 px-2.5 py-1.5"><p className="text-[11px] text-muted-foreground"><span className="font-medium">{t('chat.contextToolbox.collectionDisabledTitle', 'Collection disabled')}</span> {t('chat.contextToolbox.collectionDisabledDescription', 'Enable the Sources tool to save new passages.')}</p></div>}
            <div className="space-y-2">
              <Input value={sourceSearch} onChange={(event) => setSourceSearch(event.target.value)} placeholder={t('chat.contextToolbox.sourceSearchPlaceholder', 'Search sources')} className="h-9" />
              <div className="flex items-center gap-2">
                {[
                  { key: 'all' as SourceFilter, label: t('common.all', 'All'), active: 'bg-primary/10 text-primary border-primary/30', title: t('common.all', 'All') },
                  { key: 'interesting' as SourceFilter, label: t('chat.contextToolbox.found', 'Found'), active: 'bg-muted/50 text-muted-foreground border-border', title: t('chat.contextToolbox.foundTooltip', "Passage spotted during analysis") },
                  { key: 'used' as SourceFilter, label: t('chat.contextToolbox.used', 'Used'), active: 'bg-primary/10 text-primary border-primary/30', title: t('chat.contextToolbox.usedTooltip', 'Passage used in a response') },
                ].map((option) => (
                  <button key={option.key} onClick={() => setSourceFilter(option.key)} title={option.title} className={cn('px-2.5 py-1 text-xs rounded-md border transition-colors', sourceFilter === option.key ? option.active : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent')}>
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
                  const isExpanded = expandedSourceIds.has(citation.id);
                  const isInComposer = composerContextRefs.some((ref) => ref.id === citation.id && ref.kind === 'source');
                  const passage = citation.content || citation.snippet;
                  const kindTooltip = isInteresting
                    ? t('chat.contextToolbox.foundTooltip', "Passage spotted during analysis")
                    : t('chat.contextToolbox.usedTooltip', 'Passage used in a response');
                  return (
                    <div key={citation.id} className={cn('rounded-lg border px-2.5 py-1.5 transition-colors hover:bg-accent/50', isInteresting ? 'border-border bg-muted/50' : 'border-primary/30 bg-primary/10')}>
                      <button
                        type="button"
                        onClick={() => toggleSourceExpansion(citation.id)}
                        aria-expanded={isExpanded}
                        className="flex w-full items-start gap-1.5 text-left"
                      >
                        <div className={cn('w-5 h-5 rounded flex items-center justify-center shrink-0 mt-0.5', isInteresting ? 'bg-muted/50' : 'bg-primary/10')}>
                          <Icon name={isInteresting ? 'sparkles' : 'check'} size={10} className={cn(isInteresting ? 'text-muted-foreground' : 'text-primary')} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="text-[13px] leading-5 text-foreground truncate">{citation.title}</p>
                            <span title={kindTooltip} className={cn('text-[10px] px-1.5 py-0.5 rounded border shrink-0', isInteresting ? 'text-muted-foreground border-border bg-muted/50' : 'text-primary border-primary/30 bg-primary/10')}>
                              {isInteresting ? t('chat.contextToolbox.found', 'Found') : t('chat.contextToolbox.used', 'Used')}
                            </span>
                            <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} className="ml-auto shrink-0 text-muted-foreground" />
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground min-w-0">
                            <span className="truncate">{citation.url || citation.source}</span>
                            <span className="shrink-0">•</span>
                            <span className="shrink-0">{formatRelativeTimeShort(citation.timestamp, Date.now(), locale)}</span>
                          </div>
                          {citation.reason && <p className={cn('text-[11px] leading-4 text-muted-foreground mt-0.5', isExpanded ? 'whitespace-pre-wrap' : 'line-clamp-1')}>{citation.reason}</p>}
                          {passage && <p className={cn('text-[11px] leading-4 text-foreground/90 mt-0.5', isExpanded ? 'whitespace-pre-wrap' : 'line-clamp-2')}>{passage}</p>}
                        </div>
                      </button>
                      <div className="mt-1 flex items-center gap-1">
                        {citation.url && <button onClick={() => window.open(citation.url!, '_blank', 'noopener,noreferrer')} title={t('chat.contextToolbox.openSource', 'Open source')} className="p-1 rounded border border-border hover:bg-accent transition-colors"><Icon name="external-link" size={12} className="text-muted-foreground" /></button>}
                        <button onClick={() => window.dispatchEvent(new CustomEvent('macro:focus-message', { detail: { messageId: citation.messageId } }))} title={t('chat.contextToolbox.viewInResponse', 'View in response')} className="p-1 rounded border border-border hover:bg-accent transition-colors"><Icon name="message-square" size={12} className="text-muted-foreground" /></button>
                        {passage && <button onClick={() => navigator.clipboard.writeText(passage).catch(() => undefined)} title={t('chat.contextToolbox.copySnippet', 'Copy snippet')} className="p-1 rounded border border-border hover:bg-accent transition-colors"><Icon name="copy" size={12} className="text-muted-foreground" /></button>}
                        <button
                          onClick={() => handleAddSourceToComposer(citation)}
                          disabled={isInComposer}
                          title={isInComposer ? t('chat.contextToolbox.sourceAlreadyInComposer', 'Already in composer') : t('chat.contextToolbox.addSourceToComposer', 'Add to composer')}
                          className={cn('p-1 rounded border border-border transition-colors', isInComposer ? 'text-primary bg-primary/10 cursor-default' : 'text-muted-foreground hover:text-foreground hover:bg-accent')}
                        >
                          <Icon name={isInComposer ? 'check' : 'plus'} size={12} />
                        </button>
                        <button onClick={() => handleRemoveSourceCitation(citation.id)} title={t('common.delete', 'Delete')} className="p-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ml-auto"><Icon name="trash" size={12} /></button>
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
