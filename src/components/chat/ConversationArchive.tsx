import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../../stores/useChatStore';
import { useCitationsStore } from '../../stores/useCitationsStore';
import { loadPreference, PREF_KEYS, savePreference } from '../../services/preferences';
import { Icon } from '../ui/Icon';
import { SearchBar } from '../ui/SearchBar';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { toast } from '../ui/toastService';
import { cn } from '../../utils/cn';
import { formatDate } from '../../i18n/format';
import type { Conversation } from '../../types';
import {
  areConversationIdSetsEqual,
  filterConversationsByQuery,
  getArchiveViewConversations,
  getChatOnlyConversations,
  normalizeConversationIdList,
  partitionPinnedConversations,
  pruneConversationIdSet,
  toggleAllConversationIds,
  toggleConversationIdInSet,
} from './conversationArchiveState';
import { useVirtualList } from '../../hooks/useVirtualList';

interface ConversationArchiveProps {
  className?: string;
}

interface ConversationItemProps {
  conversation: Conversation;
  isCurrentConversation: boolean;
  isChecked: boolean;
  isPinned: boolean;
  isMultiSelectMode: boolean;
  isArchivedView: boolean;
  onActivate: () => void;
  onToggleSelection: () => void;
  onPin: () => void;
  onArchiveToggle: () => void;
  onDeleteComplete: (conversationId: string) => void;
}

type ArchiveListRow =
  | {
      kind: 'section';
      id: string;
      title: string;
      icon: 'pin' | 'clock';
    }
  | {
      kind: 'conversation';
      id: string;
      conversation: Conversation;
      isPinned: boolean;
    };

const readArchivedConversationPreferenceCache = (): {
  ids: string[];
  hasCachedValue: boolean;
} => {
  if (typeof window === 'undefined') {
    return { ids: [], hasCachedValue: false };
  }

  const cacheKey = `macro_${PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS}`;
  const rawValue = window.localStorage.getItem(cacheKey);
  if (rawValue === null) {
    return { ids: [], hasCachedValue: false };
  }

  try {
    return {
      ids: normalizeConversationIdList(JSON.parse(rawValue)),
      hasCachedValue: true,
    };
  } catch {
    return { ids: [], hasCachedValue: true };
  }
};

const removeConversationIdsFromSet = (
  current: ReadonlySet<string>,
  idsToRemove: ReadonlySet<string>
): Set<string> => new Set([...current].filter((conversationId) => !idsToRemove.has(conversationId)));

const ConversationItem: React.FC<ConversationItemProps> = ({
  conversation,
  isCurrentConversation,
  isChecked,
  isPinned,
  isMultiSelectMode,
  isArchivedView,
  onActivate,
  onToggleSelection,
  onPin,
  onArchiveToggle,
  onDeleteComplete,
}) => {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { renameConversation, deleteConversation } = useChatStore();
  const { clearConversationCitations } = useCitationsStore();
  const isHighlighted = isMultiSelectMode ? isChecked : isCurrentConversation;

  useEffect(() => {
    if (isMultiSelectMode) {
      setShowMenu(false);
    }
  }, [isMultiSelectMode]);

  const handleRename = async (newTitle?: string) => {
    if (newTitle && newTitle !== conversation.title) {
      await renameConversation(conversation.id, newTitle);
    }
    setIsRenameOpen(false);
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteConversation(conversation.id, { mode: 'chat' });
      clearConversationCitations(conversation.id);
      onDeleteComplete(conversation.id);
      setDeleteError(null);
      setIsDeleteOpen(false);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : t('chat.deleteConversationError', 'Deletion failed.')
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleExport = () => {
    const { messages } = useChatStore.getState();
    const conversationMessages = messages.filter(
      (message) => message.conversation_id === conversation.id
    );
    const exportData = {
      title: conversation.title,
      messages: conversationMessages,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${conversation.title.replace(/\s+/g, '_')}_export.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setShowMenu(false);
  };

  const archiveActionLabel = isArchivedView ? t('common.restore', 'Restore') : t('common.archive', 'Archive');
  const archiveActionIcon = isArchivedView ? 'rotate-ccw' : 'archive';

  return (
    <div className="relative">
      <div
        role="button"
        tabIndex={0}
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onActivate();
          }
        }}
        className={cn(
          'w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-200 group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          isHighlighted ? 'bg-primary/10 border-primary/30' : 'border-transparent hover:bg-accent'
        )}
      >
        <div className="flex items-start gap-3">
          {isMultiSelectMode && (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleSelection();
              }}
              className="mt-1 h-4 w-4 rounded border border-border bg-background flex items-center justify-center shrink-0 hover:border-primary/60 transition-colors"
              aria-label={isChecked ? t('chat.deselectConversation', 'Deselect conversation') : t('chat.selectConversation', 'Select conversation')}
            >
              {isChecked && <Icon name="check" size={11} className="text-primary" />}
            </button>
          )}

          <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', isHighlighted ? 'bg-primary/20' : 'bg-muted')}>
            <Icon name="message-circle" size={14} className={isHighlighted ? 'text-primary' : 'text-muted-foreground'} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-foreground truncate">{conversation.title}</h3>
              {conversation.is_unread && <span className="w-2 h-2 rounded-full bg-primary shrink-0" />}
              {isPinned && <Icon name="pin" size={10} className="text-primary shrink-0" />}
            </div>
            {conversation.description && <p className="text-xs text-muted-foreground mt-0.5 truncate">{conversation.description}</p>}
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-xs text-muted-foreground/70">{formatDate(conversation.updated_at)}</span>
              <span className="text-xs text-muted-foreground/70 flex items-center gap-1">
                <Icon name="message-square" size={8} />
                {conversation.message_count}
              </span>
            </div>
          </div>

          {!isMultiSelectMode && (
            <button
              type="button"
              onClick={(event) => {
                if (isDeleting) return;
                event.stopPropagation();
                setShowMenu((current) => !current);
              }}
              disabled={isDeleting}
              className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={t('chat.conversationActions', 'Conversation actions')}
            >
              <Icon name="more-vertical" size={12} className="text-muted-foreground" />
            </button>
          )}
        </div>
      </div>
      {showMenu && !isMultiSelectMode && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div
            className="absolute right-2 top-full z-50 mt-1 w-40 bg-card border border-border rounded-lg shadow-lg py-1"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                if (isDeleting) return;
                onPin();
                setShowMenu(false);
              }}
              disabled={isDeleting}
              className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
            >
              <Icon name="pin" size={12} />
              {isPinned ? t('chat.unpinConversation', 'Unpin') : t('chat.pinConversation', 'Pin')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (isDeleting) return;
                setShowMenu(false);
                setIsRenameOpen(true);
              }}
              disabled={isDeleting}
              className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
            >
              <Icon name="edit" size={12} />
              {t('common.rename', 'Rename')}
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={isDeleting}
              className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
            >
              <Icon name="download" size={12} />
              {t('common.export', 'Export')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (isDeleting) return;
                setShowMenu(false);
                void onArchiveToggle();
              }}
              disabled={isDeleting}
              className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
            >
              <Icon name={archiveActionIcon} size={12} />
              {archiveActionLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                if (isDeleting) return;
                setShowMenu(false);
                setDeleteError(null);
                setIsDeleteOpen(true);
              }}
              disabled={isDeleting}
              className="w-full px-3 py-1.5 text-left text-sm text-red-500 hover:bg-red-500/10 flex items-center gap-2"
            >
              <Icon name="trash" size={12} />
              {t('common.delete', 'Delete')}
            </button>
          </div>
        </>
      )}

      <ConfirmPromptModal
        isOpen={isRenameOpen}
        title={t('chat.renameConversationTitle', 'Rename conversation')}
        description={t('chat.renameConversationDescription', 'Choose a new title for this conversation.')}
        confirmLabel={t('common.rename', 'Rename')}
        cancelLabel={t('common.cancel', 'Cancel')}
        initialValue={conversation.title}
        inputPlaceholder={t('chat.conversationName', 'Conversation name')}
        requireInput
        onCancel={() => setIsRenameOpen(false)}
        onConfirm={(value) => {
          void handleRename(value);
        }}
      />

      <ConfirmPromptModal
        isOpen={isDeleteOpen}
        title={t('chat.deleteConversationTitle', 'Delete conversation')}
        description={deleteError || t('chat.deleteConversationConfirm', 'Are you sure you want to delete this conversation?')}
        confirmLabel={isDeleting ? t('chat.deletingConversation', 'Deleting...') : t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error"
        initialValue=""
        onCancel={() => setIsDeleteOpen(false)}
        isSubmitting={isDeleting}
        onConfirm={() => {
          void handleDelete();
        }}
      />
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
    deleteChatConversations,
  } = useChatStore(useShallow((state) => ({
    conversations: state.conversations,
    selectedConversationId: state.selectedConversationId,
    selectConversation: state.selectConversation,
    createConversation: state.createConversation,
    deleteChatConversations: state.deleteChatConversations,
  })));
  const clearConversationCitationsBulk = useCitationsStore((state) => state.clearConversationCitationsBulk);

  const [searchQuery, setSearchQuery] = useState('');
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [archivedIds, setArchivedIds] = useState<Set<string>>(
    () => new Set(readArchivedConversationPreferenceCache().ids)
  );
  const [isArchivePersistenceReady, setIsArchivePersistenceReady] = useState(
    () => readArchivedConversationPreferenceCache().hasCachedValue
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (isArchivePersistenceReady) {
      return;
    }

    let cancelled = false;

    void loadPreference<string[]>(PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS)
      .then((storedIds) => {
        if (cancelled) {
          return;
        }

        setArchivedIds((current) =>
          current.size > 0 ? current : new Set(normalizeConversationIdList(storedIds))
        );
      })
      .finally(() => {
        if (!cancelled) {
          setIsArchivePersistenceReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isArchivePersistenceReady]);

  useEffect(() => {
    if (!isArchivePersistenceReady) {
      return;
    }

    void savePreference(PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS, Array.from(archivedIds));
  }, [archivedIds, isArchivePersistenceReady]);

  const chatConversations = useMemo(
    () => getChatOnlyConversations(conversations),
    [conversations]
  );
  const chatConversationIds = useMemo(
    () => chatConversations.map((conversation) => conversation.id),
    [chatConversations]
  );

  useEffect(() => {
    setPinnedIds((current) => {
      const next = pruneConversationIdSet(current, chatConversationIds);
      return areConversationIdSetsEqual(current, next) ? current : next;
    });
    setSelectedIds((current) => {
      const next = pruneConversationIdSet(current, chatConversationIds);
      return areConversationIdSetsEqual(current, next) ? current : next;
    });
    setArchivedIds((current) => {
      const next = pruneConversationIdSet(current, chatConversationIds);
      return areConversationIdSetsEqual(current, next) ? current : next;
    });
  }, [chatConversationIds]);

  const archiveSourceConversations = useMemo(
    () => getArchiveViewConversations(chatConversations, archivedIds, showArchived),
    [archivedIds, chatConversations, showArchived]
  );
  const filteredConversations = useMemo(
    () => filterConversationsByQuery(archiveSourceConversations, searchQuery),
    [archiveSourceConversations, searchQuery]
  );
  const { pinnedConversations, regularConversations } = useMemo(
    () => partitionPinnedConversations(filteredConversations, pinnedIds),
    [filteredConversations, pinnedIds]
  );
  const visibleConversationIds = useMemo(
    () => filteredConversations.map((conversation) => conversation.id),
    [filteredConversations]
  );
  const archiveRows = useMemo<ArchiveListRow[]>(() => {
    const rows: ArchiveListRow[] = [];

    if (pinnedConversations.length > 0) {
      rows.push({
        kind: 'section',
        id: 'section:pinned',
        title: t('chat.pinned', 'Pinned'),
        icon: 'pin',
      });
      rows.push(
        ...pinnedConversations.map((conversation) => ({
          kind: 'conversation' as const,
          id: `conversation:${conversation.id}`,
          conversation,
          isPinned: true,
        }))
      );
    }

    if (regularConversations.length > 0) {
      if (pinnedConversations.length > 0) {
        rows.push({
          kind: 'section',
          id: 'section:recent',
          title: t('chat.recent', 'Recent'),
          icon: 'clock',
        });
      }
      rows.push(
        ...regularConversations.map((conversation) => ({
          kind: 'conversation' as const,
          id: `conversation:${conversation.id}`,
          conversation,
          isPinned: false,
        }))
      );
    }

    return rows;
  }, [pinnedConversations, regularConversations, t]);
  const {
    parentRef: archiveListRef,
    virtualItems: archiveVirtualItems,
    totalSize: archiveListTotalSize,
    measureElement: measureArchiveRow,
  } = useVirtualList({
    items: archiveRows,
    estimateSize: 88,
    overscan: 8,
    dynamicHeight: true,
    gap: 8,
  });

  useEffect(() => {
    if (!isMultiSelectMode) {
      return;
    }

    setSelectedIds((current) => {
      const next = pruneConversationIdSet(current, visibleConversationIds);
      return areConversationIdSetsEqual(current, next) ? current : next;
    });
  }, [isMultiSelectMode, visibleConversationIds]);

  const isAllVisibleSelected =
    visibleConversationIds.length > 0 &&
    visibleConversationIds.every((conversationId) => selectedIds.has(conversationId));

  const exitMultiSelectMode = useCallback(() => {
    setIsMultiSelectMode(false);
    setSelectedIds(new Set());
    setBulkDeleteError(null);
    setIsBulkDeleteOpen(false);
  }, []);

  const togglePin = useCallback((conversationId: string) => {
    setPinnedIds((current) => toggleConversationIdInSet(current, conversationId));
  }, []);

  const toggleSelection = useCallback((conversationId: string) => {
    setSelectedIds((current) => toggleConversationIdInSet(current, conversationId));
  }, []);

  const applyConversationArchiveState = useCallback(
    (conversationIds: string[], shouldArchive: boolean) => {
      const normalizedIds = normalizeConversationIdList(conversationIds);
      if (normalizedIds.length === 0) {
        return;
      }

      const idsToUpdate = new Set(normalizedIds);

      setArchivedIds((current) => {
        const next = new Set(current);
        normalizedIds.forEach((conversationId) => {
          if (shouldArchive) {
            next.add(conversationId);
            return;
          }
          next.delete(conversationId);
        });
        return areConversationIdSetsEqual(current, next) ? current : next;
      });

      setSelectedIds((current) => {
        const next = removeConversationIdsFromSet(current, idsToUpdate);
        return areConversationIdSetsEqual(current, next) ? current : next;
      });

      if (selectedConversationId && idsToUpdate.has(selectedConversationId)) {
        const fallbackConversation = archiveSourceConversations.find(
          (conversation) => !idsToUpdate.has(conversation.id)
        );
        if (fallbackConversation) {
          selectConversation(fallbackConversation.id);
        }
      }

      toast.success(
        shouldArchive
          ? normalizedIds.length === 1
            ? t('chat.conversationArchived', 'Conversation archived')
            : t('chat.conversationsArchived', '{{count}} conversations archived', {
                count: normalizedIds.length,
              })
          : normalizedIds.length === 1
            ? t('chat.conversationRestored', 'Conversation restored')
            : t('chat.conversationsRestored', '{{count}} conversations restored', {
                count: normalizedIds.length,
              })
      );
    },
    [archiveSourceConversations, selectConversation, selectedConversationId, t]
  );

  const handleConversationDeleted = useCallback((conversationId: string) => {
    const idsToRemove = new Set([conversationId]);

    setPinnedIds((current) => {
      if (!current.has(conversationId)) {
        return current;
      }
      return removeConversationIdsFromSet(current, idsToRemove);
    });

    setSelectedIds((current) => {
      if (!current.has(conversationId)) {
        return current;
      }
      return removeConversationIdsFromSet(current, idsToRemove);
    });

    setArchivedIds((current) => {
      if (!current.has(conversationId)) {
        return current;
      }
      return removeConversationIdsFromSet(current, idsToRemove);
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds((current) => toggleAllConversationIds(current, visibleConversationIds));
  }, [visibleConversationIds]);

  const handleBulkArchiveAction = useCallback(() => {
    const conversationIds = Array.from(selectedIds);
    if (conversationIds.length === 0) {
      return;
    }

    applyConversationArchiveState(conversationIds, !showArchived);
    exitMultiSelectMode();
  }, [applyConversationArchiveState, exitMultiSelectMode, selectedIds, showArchived]);

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0 || isBulkDeleting) return;

    const conversationIds = Array.from(selectedIds);
    const idsToDelete = new Set(conversationIds);
    setIsBulkDeleting(true);
    setBulkDeleteError(null);

    try {
      await deleteChatConversations(conversationIds);
      clearConversationCitationsBulk(conversationIds);
      setPinnedIds((current) => removeConversationIdsFromSet(current, idsToDelete));
      setArchivedIds((current) => removeConversationIdsFromSet(current, idsToDelete));
      setSelectedIds(new Set());
      setIsMultiSelectMode(false);
      setIsBulkDeleteOpen(false);
      toast.success(
        t('toast.chatConversationsDeleted', {
          count: conversationIds.length,
          defaultValue: '{{count}} conversations deleted',
        })
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('toast.chatDeleteFailed', 'Failed to delete conversations');
      setBulkDeleteError(message);
      toast.error(t('toast.chatDeleteFailed', 'Failed to delete conversations'), {
        description: message,
      });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const handleNewChat = useCallback(() => {
    if (showArchived) {
      setShowArchived(false);
    }
    exitMultiSelectMode();
    void createConversation(t('chat.newConversation', 'New Conversation'), null, null);
  }, [createConversation, exitMultiSelectMode, showArchived, t]);

  const handleToggleArchivedView = useCallback(() => {
    exitMultiSelectMode();
    setShowArchived((current) => !current);
  }, [exitMultiSelectMode]);

  const footerCountLabel = showArchived
    ? t('chat.archivedConversationCount', '{{count}} archived', {
        count: archiveSourceConversations.length,
      })
    : t('chat.conversationCount', '{{count}} conversations', {
        count: archiveSourceConversations.length,
      });
  const archiveButtonLabel = showArchived
    ? t('common.restore', 'Restore')
    : t('common.archive', 'Archive');
  const archiveButtonIcon = showArchived ? 'rotate-ccw' : 'archive';
  const footerButtonLabel = showArchived
    ? t('chat.activeConversations', 'Conversations')
    : t('chat.archives', 'Archives');
  const footerButtonIcon = showArchived ? 'arrow-left' : 'archive';
  const hasNoActiveConversations = !showArchived && archiveSourceConversations.length === 0;
  const hasAnyChatConversations = chatConversations.length > 0;

  return (
    <>
      <aside className={cn('h-full w-full bg-card border-r border-border flex flex-col', className)}>
        <div className="h-12 border-b border-border flex items-center justify-between px-4">
          <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Icon name="message-circle" size={16} className="text-primary" />
            {t('chat.conversations', 'Conversations')}
          </h1>
          <button
            onClick={handleNewChat}
            disabled={isBulkDeleting}
            className="p-1 hover:bg-accent rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('chat.newChat', 'New Chat')}
          >
            <Icon name="plus" size={16} className="text-muted-foreground" />
          </button>
        </div>

        <div className="px-3 py-2 border-b border-border">
          {isMultiSelectMode ? (
            <div className="overflow-x-auto overflow-y-hidden">
              <div className="flex min-w-max items-center gap-2 pr-1">
                <button
                  onClick={handleToggleSelectAll}
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={visibleConversationIds.length === 0 || isBulkDeleting}
                >
                  <Icon name={isAllVisibleSelected ? 'square' : 'check-square'} size={12} />
                  <span className="whitespace-nowrap">{t('common.selectAll', 'Select all')}</span>
                </button>

                <span className="shrink-0 text-xs text-muted-foreground">
                  {t('chat.selectedCount', '{{count}} selected', { count: selectedIds.size })}
                </span>
                <button
                  onClick={handleBulkArchiveAction}
                  type="button"
                  disabled={selectedIds.size === 0 || isBulkDeleting}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  title={archiveButtonLabel}
                >
                  <Icon name={archiveButtonIcon} size={12} />
                  <span className="whitespace-nowrap">{archiveButtonLabel}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBulkDeleteError(null);
                    setIsBulkDeleteOpen(true);
                  }}
                  disabled={selectedIds.size === 0 || isBulkDeleting}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('common.delete', 'Delete')}
                >
                  <Icon name="trash" size={12} />
                  <span className="whitespace-nowrap">{t('common.delete', 'Delete')}</span>
                </button>
                <button
                  type="button"
                  onClick={exitMultiSelectMode}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Icon name="x" size={12} />
                  <span className="whitespace-nowrap">{t('common.cancel', 'Cancel')}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 min-w-0">
              <button
                type="button"
                onClick={() => {
                  setSelectedIds(new Set());
                  setIsMultiSelectMode(true);
                }}
                disabled={filteredConversations.length === 0 || isBulkDeleting}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Icon name="check-square" size={12} />
                <span className="truncate">{t('chat.multiSelect', 'Multi-select')}</span>
              </button>
              {showArchived && (
                <span className="text-xs text-muted-foreground">
                  {t('chat.archivedView', 'Archived view')}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="p-3 border-b border-border">
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('chat.searchConversations', 'Search conversations...')}
          />
        </div>

        <div ref={archiveListRef} className="flex-1 overflow-y-auto">
          {archiveRows.length > 0 ? (
            <div className="p-2">
              <div className="relative" style={{ height: archiveListTotalSize }}>
                {archiveVirtualItems.map((virtualRow) => {
                  const row = virtualRow.item;
                  return (
                    <div
                      key={row.id}
                      ref={measureArchiveRow}
                      data-index={virtualRow.index}
                      className="absolute left-0 top-0 w-full"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      {row.kind === 'section' ? (
                        <div className="flex items-center gap-2 px-2 mb-1">
                          <Icon
                            name={row.icon}
                            size={12}
                            className={row.icon === 'pin' ? 'text-primary' : 'text-muted-foreground'}
                          />
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            {row.title}
                          </span>
                        </div>
                      ) : (
                        <ConversationItem
                          conversation={row.conversation}
                          isCurrentConversation={selectedConversationId === row.conversation.id}
                          isChecked={selectedIds.has(row.conversation.id)}
                          isPinned={row.isPinned}
                          isMultiSelectMode={isMultiSelectMode}
                          isArchivedView={showArchived}
                          onActivate={() =>
                            isMultiSelectMode
                              ? toggleSelection(row.conversation.id)
                              : selectConversation(row.conversation.id)
                          }
                          onToggleSelection={() => toggleSelection(row.conversation.id)}
                          onPin={() => togglePin(row.conversation.id)}
                          onArchiveToggle={() => applyConversationArchiveState([row.conversation.id], !showArchived)}
                          onDeleteComplete={handleConversationDeleted}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : searchQuery.trim() ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4">
              <Icon name="search" size={32} className="text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">
                {showArchived
                  ? t('chat.noArchivedResults', 'No archived conversations found')
                  : t('chat.noResults', 'No conversations found')}
              </p>
            </div>
          ) : showArchived ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4">
              <Icon name="archive" size={32} className="text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">
                {t('chat.noArchivedConversations', 'No archived conversations')}
              </p>
            </div>
          ) : !hasAnyChatConversations ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4">
              <Icon name="message-circle" size={32} className="text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground mb-2">
                {t('chat.noConversations', 'No conversations yet')}
              </p>
              <button onClick={handleNewChat} className="text-xs text-primary hover:underline">
                {t('chat.startNew', 'Start a new conversation')}
              </button>
            </div>
          ) : hasNoActiveConversations ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4">
              <Icon name="archive" size={32} className="text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground mb-2">
                {t('chat.noActiveConversations', 'No active conversations')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('chat.noActiveConversationsDescription', 'Your conversations are currently in Archives.')}
              </p>
            </div>
          ) : null}
        </div>

        <div className="h-12 border-t border-border flex items-center justify-between px-4 bg-card">
          <span className="text-xs text-muted-foreground">{footerCountLabel}</span>
          <button
            type="button"
            onClick={handleToggleArchivedView}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Icon name={footerButtonIcon} size={12} />
            {footerButtonLabel}
          </button>
        </div>
      </aside>

      <ConfirmPromptModal
        isOpen={isBulkDeleteOpen}
        title={showArchived ? t('chat.deleteArchivedConversationsTitle', 'Delete archived conversations') : t('chat.deleteConversationTitle', 'Delete conversation')}
        description={
          bulkDeleteError ||
          (selectedIds.size > 1
            ? t('chat.deleteConversationCount', {
                count: selectedIds.size,
                defaultValue: '{{count}} conversations will be deleted.',
              })
            : t('chat.deleteConversation', 'Delete this conversation?'))
        }
        confirmLabel={isBulkDeleting ? t('chat.deletingConversations', 'Deleting...') : t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error"
        initialValue=""
        isSubmitting={isBulkDeleting}
        onCancel={() => {
          setBulkDeleteError(null);
          setIsBulkDeleteOpen(false);
        }}
        onConfirm={() => {
          void handleDeleteSelected();
        }}
      />
    </>
  );
};

export default ConversationArchive;
