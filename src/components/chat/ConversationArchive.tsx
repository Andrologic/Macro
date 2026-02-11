import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/useChatStore';
import { useCitationsStore } from '../../stores/useCitationsStore';
import { Icon } from '../ui/Icon';
import { SearchBar } from '../ui/SearchBar';
import { cn } from '../../utils/cn';
import type { Conversation } from '../../types';

interface ConversationArchiveProps {
  className?: string;
}

/**
 * ConversationArchive - Displays conversation history in Chat mode
 *
 * PERFORMANCE: Lazy loaded via ModeRouter, only rendered when Chat mode is active
 */

interface ConversationItemProps {
  conversation: Conversation;
  isSelected: boolean;
  onSelect: () => void;
  onPin?: () => void;
  isPinned?: boolean;
}

const ConversationItem: React.FC<ConversationItemProps> = ({
  conversation,
  isSelected,
  onSelect,
  onPin,
  isPinned,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const { renameConversation, deleteConversation } = useChatStore();
  const { clearConversationCitations } = useCitationsStore();

  const handleRename = async () => {
    const newTitle = window.prompt('Rename conversation:', conversation.title);
    if (newTitle && newTitle !== conversation.title) {
      await renameConversation(conversation.id, newTitle);
    }
    setShowMenu(false);
  };

  const handleDelete = async () => {
    if (window.confirm('Are you sure you want to delete this conversation?')) {
      await deleteConversation(conversation.id);
      clearConversationCitations(conversation.id);
    }
    setShowMenu(false);
  };

  const handleExport = () => {
    const { messages } = useChatStore.getState();
    const conversationMessages = messages.filter(m => m.conversation_id === conversation.id);
    
    const exportData = {
      title: conversation.title,
      messages: conversationMessages,
      exportedAt: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${conversation.title.replace(/\s+/g, '_')}_export.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    setShowMenu(false);
  };

  return (
    <div className="relative">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          'w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-200 group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          isSelected
            ? 'bg-primary/10 border-primary/30'
            : 'border-transparent hover:bg-accent'
        )}
      >
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
            isSelected ? 'bg-primary/20' : 'bg-muted'
          )}>
            <Icon
              name="message-circle"
              size={14}
              className={isSelected ? 'text-primary' : 'text-muted-foreground'}
            />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-foreground truncate">
                {conversation.title}
              </h3>
              {conversation.is_unread && (
                <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
              )}
              {isPinned && (
                <Icon name="pin" size={10} className="text-primary shrink-0" />
              )}
            </div>

            {/* Description preview */}
            {conversation.description && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {conversation.description}
              </p>
            )}

            {/* Meta */}
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-xs text-muted-foreground/70">
                {new Date(conversation.updated_at).toLocaleDateString()}
              </span>
              <span className="text-xs text-muted-foreground/70 flex items-center gap-1">
                <Icon name="message-square" size={8} />
                {conversation.message_count}
              </span>
            </div>
          </div>

          {/* Menu button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Icon name="more-vertical" size={12} className="text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {showMenu && (
        <>
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setShowMenu(false)}
          />
          <div
            className="absolute right-2 top-full z-50 mt-1 w-36 bg-card border border-border rounded-lg shadow-lg py-1"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                onPin?.();
                setShowMenu(false);
              }}
              className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
            >
              <Icon name="pin" size={12} />
              {isPinned ? 'Unpin' : 'Pin'}
            </button>
            <button 
              onClick={handleRename}
              className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
            >
              <Icon name="edit" size={12} />
              Rename
            </button>
            <button 
              onClick={handleExport}
              className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
            >
              <Icon name="download" size={12} />
              Export
            </button>
            <button 
              onClick={handleDelete}
              className="w-full px-3 py-1.5 text-left text-sm text-red-500 hover:bg-red-500/10 flex items-center gap-2"
            >
              <Icon name="trash" size={12} />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export const ConversationArchive: React.FC<ConversationArchiveProps> = ({ className }) => {
  const { t } = useTranslation();
  const {
    conversations,
    selectedConversationId,
    selectConversation,
    createConversation,
  } = useChatStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  // Use real conversations from store (filter to chat-only conversations with no project_id)
  const chatConversations = useMemo(() => 
    conversations.filter(c => !c.project_id).sort((a, b) => 
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    ),
  [conversations]);

  // Filter conversations
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) {
      return chatConversations;
    }

    const query = searchQuery.toLowerCase();
    return chatConversations.filter(
      (conv) =>
        conv.title.toLowerCase().includes(query) ||
        conv.description?.toLowerCase().includes(query)
    );
  }, [chatConversations, searchQuery]);

  // Separate pinned and regular
  const pinnedConversations = filteredConversations.filter((c) => pinnedIds.has(c.id));
  const regularConversations = filteredConversations.filter((c) => !pinnedIds.has(c.id));

  const togglePin = (id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleNewChat = () => {
    createConversation(t('chat.newConversation', 'New Conversation'), null, null);
  };

  return (
    <aside
      className={cn("h-full w-full bg-card border-r border-border flex flex-col", className)}
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="message-circle" size={16} className="text-primary" />
          {t('chat.conversations', 'Conversations')}
        </h1>
        <button
          onClick={handleNewChat}
          className="p-1 hover:bg-accent rounded-md transition-colors"
          title={t('chat.newChat', 'New Chat')}
        >
          <Icon name="plus" size={16} className="text-muted-foreground" />
        </button>
      </div>

      {/* Search */}
      <div className="p-3 border-b border-border">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t('chat.searchConversations', 'Search conversations...')}
        />
      </div>

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto p-2">
        {/* Pinned Section */}
        {pinnedConversations.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 px-2 mb-2">
              <Icon name="pin" size={12} className="text-primary" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t('chat.pinned', 'Pinned')}
              </span>
            </div>
            <div className="space-y-1">
              {pinnedConversations.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  isSelected={selectedConversationId === conv.id}
                  onSelect={() => selectConversation(conv.id)}
                  onPin={() => togglePin(conv.id)}
                  isPinned
                />
              ))}
            </div>
          </div>
        )}

        {/* Regular Conversations */}
        {regularConversations.length > 0 ? (
          <div className="space-y-1">
            {pinnedConversations.length > 0 && (
              <div className="flex items-center gap-2 px-2 mb-2">
                <Icon name="clock" size={12} className="text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('chat.recent', 'Recent')}
                </span>
              </div>
            )}
            {regularConversations.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isSelected={selectedConversationId === conv.id}
                onSelect={() => selectConversation(conv.id)}
                onPin={() => togglePin(conv.id)}
                isPinned={false}
              />
            ))}
          </div>
        ) : filteredConversations.length === 0 && searchQuery ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Icon name="search" size={32} className="text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              {t('chat.noResults', 'No conversations found')}
            </p>
          </div>
        ) : chatConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center px-4">
            <Icon name="message-circle" size={32} className="text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-2">
              {t('chat.noConversations', 'No conversations yet')}
            </p>
            <button
              onClick={handleNewChat}
              className="text-xs text-primary hover:underline"
            >
              {t('chat.startNew', 'Start a new conversation')}
            </button>
          </div>
        ) : null}
      </div>

      {/* Footer */}
      <div className="h-12 border-t border-border flex items-center justify-between px-4 bg-card">
        <span className="text-xs text-muted-foreground">
          {chatConversations.length} conversation{chatConversations.length > 1 ? 's' : ''}
        </span>
        <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
          <Icon name="archive" size={12} />
          Archives
        </button>
      </div>
    </aside>
  );
};

// Export both named and default for lazy loading compatibility
export default ConversationArchive;
