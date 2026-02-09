import { create } from 'zustand';
import { ChatMessage, Conversation } from '../types';
import { toServiceError } from '../services/contracts/errors';
import { useProviderStore } from './useProviderStore';
import { useCitationsStore } from './useCitationsStore';
import { streamChat, cancelStream } from '../services/streamingChat';
import * as tauriIpc from '../services/tauriIpc';

interface ChatStore {
  messages: ChatMessage[];
  conversations: Conversation[];
  selectedConversationId: string | null;
  isLoading: boolean;
  isStreaming: boolean;
  lastError: string | null;
  abortController: AbortController | null;
  addMessage: (message: ChatMessage) => void;
  updateMessageContent: (messageId: string, content: string) => void;
  updateLastMessage: (content: string) => void;
  appendToLastMessage: (token: string) => void;
  clearMessages: () => void;
  selectConversation: (conversationId: string) => void;
  createConversation: (
    title: string,
    taskId: string | null,
    projectId: string | null
  ) => Promise<Conversation>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  markAsRead: (conversationId: string) => void;
  getConversationByTask: (taskId: string) => Conversation | undefined;
  getConversationMessages: (conversationId: string) => ChatMessage[];
  sendMessage: (payload: {
    conversationId: string;
    content: string;
    taskId?: string | null;
  }) => Promise<void>;
  stopStreaming: () => void;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  initialize: () => Promise<void>;
}

export const useChatStore = create<ChatStore>((set, get) => {
  const handleToolCall = (
    conversationId: string,
    assistantMessageId: string,
    toolName: string,
    args: Record<string, unknown>
  ) => {
    if (toolName !== 'mark_source_passage') return;
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const passage = typeof args.passage === 'string' ? args.passage.trim() : '';
    if (!title || !passage) return;

    useCitationsStore.getState().addSourcePassage({
      conversationId,
      messageId: assistantMessageId,
      title,
      passage,
      source: typeof args.source === 'string' ? args.source : undefined,
      url: typeof args.url === 'string' ? args.url : undefined,
    });
  };

  const getOrderedConversationMessages = (conversationId: string) => {
    const state = get();
    return state.messages
      .filter((msg) => msg.conversation_id === conversationId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  };

  const prepareMessagesForRequest = (conversationId: string) => {
    const contextCitations = useCitationsStore.getState().getConversationContextCitations(conversationId);
    const sourceCitations = useCitationsStore.getState().getConversationSourceCitations(conversationId);
    const citations = [...contextCitations, ...sourceCitations];
    const fileCitations = contextCitations.filter((c) => c.type === 'file' || c.type === 'document');
    const availableFiles = fileCitations
      .map((c) => c.path || c.title || c.source)
      .filter(Boolean)
      .join(', ');
    const orderedMessages = getOrderedConversationMessages(conversationId);
    const lastUserIndex = orderedMessages.map(m => m.role).lastIndexOf('user');

    const preparedMessages = orderedMessages.map((message, index) => {
      let messageContent = message.content;

      // Inject context into the last user message
      if (index === lastUserIndex && citations.length > 0) {
        const contextBlock = citations
          .map((c, i) => {
            const kind = c.scope === 'source' ? 'Important Source' : 'Context';
            return `[${kind} ${i + 1}: ${c.title}]\n${c.snippet || c.source || ''}`;
          })
          .join('\n\n---\n\n');
        
        messageContent = `CONTEXT INFORMATION:\n\n${contextBlock}\n\nUSER REQUEST: ${message.content}`;
      }

      return {
        role: message.role as 'user' | 'assistant',
        content: messageContent,
      };
    });

    return [
      {
        role: 'system' as const,
        content:
          `When the user asks to inspect or analyze an attached file, call read_file first using the file name/path. Available files: ${availableFiles || 'none'}. ` +
          'When you use a crucial excerpt from provided context or web results, call mark_source_passage with title and passage. Only call it for genuinely important passages.',
      },
      ...preparedMessages,
    ];
  };

  const recalcConversation = (conversationId: string, messages: ChatMessage[]) => {
    const conversationMessages = messages.filter(
      (message) => message.conversation_id === conversationId
    );
    const lastMessage = conversationMessages[conversationMessages.length - 1];
    return {
      message_count: conversationMessages.length,
      last_message: lastMessage?.content ?? '',
      updated_at: new Date().toISOString(),
    };
  };

  return {
    messages: [],
    conversations: [],
    selectedConversationId: null,
    isLoading: false,
    isStreaming: false,
    lastError: null,
    abortController: null,

    addMessage: (message) =>
      set((state) => {
        const conversations = state.conversations.map((conv) =>
          conv.id === message.conversation_id
            ? {
                ...conv,
                last_message: message.content,
                message_count: conv.message_count + 1,
                updated_at: new Date().toISOString(),
                is_unread: message.role === 'assistant' ? true : conv.is_unread,
              }
            : conv
        );
        return {
          messages: [...state.messages, message],
          conversations,
        };
      }),

    updateMessageContent: (messageId, content) =>
      set((state) => {
        const updatedMessages = state.messages.map((message) =>
          message.id === messageId ? { ...message, content } : message
        );

        const updatedMessage = state.messages.find((message) => message.id === messageId);
        if (!updatedMessage) {
          return { messages: updatedMessages };
        }

        const conversationMeta = recalcConversation(
          updatedMessage.conversation_id,
          updatedMessages
        );

        const conversations = state.conversations.map((conv) =>
          conv.id === updatedMessage.conversation_id
            ? { ...conv, ...conversationMeta }
            : conv
        );

        return { messages: updatedMessages, conversations };
      }),

    updateLastMessage: (content) =>
      set((state) => {
        const updatedMessages = [...state.messages];
        if (updatedMessages.length > 0) {
          const lastIndex = updatedMessages.length - 1;
          updatedMessages[lastIndex] = {
            ...updatedMessages[lastIndex],
            content,
          };
        }
        return { messages: updatedMessages };
      }),

    appendToLastMessage: (token) =>
      set((state) => {
        const updatedMessages = [...state.messages];
        if (updatedMessages.length > 0) {
          const lastIndex = updatedMessages.length - 1;
          updatedMessages[lastIndex] = {
            ...updatedMessages[lastIndex],
            content: updatedMessages[lastIndex].content + token,
          };
        }
        return { messages: updatedMessages };
      }),

    clearMessages: () => set({ messages: [] }),

    selectConversation: (conversationId) =>
      set((state) => {
        const updatedConversations = state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, is_unread: false } : conv
        );
        return { selectedConversationId: conversationId, conversations: updatedConversations };
      }),

    createConversation: async (title, taskId, projectId) => {
      let newConversation: Conversation;

      if (tauriIpc.isTauriAvailable()) {
        try {
          const dbConv = await tauriIpc.createConversation(title);
          newConversation = {
            id: dbConv.id,
            title: dbConv.title,
            task_id: taskId,
            project_id: projectId,
            last_message: dbConv.last_message || '',
            message_count: dbConv.message_count,
            updated_at: dbConv.updated_at,
            is_unread: true,
          };
        } catch (error) {
          console.error('Failed to create conversation in DB:', error);
          // Fallback to local creation
          newConversation = {
            id: `conv-${Date.now()}`,
            title,
            task_id: taskId,
            project_id: projectId,
            last_message: '',
            message_count: 0,
            updated_at: new Date().toISOString(),
            is_unread: true,
          };
        }
      } else {
        newConversation = {
          id: `conv-${Date.now()}`,
          title,
          task_id: taskId,
          project_id: projectId,
          last_message: '',
          message_count: 0,
          updated_at: new Date().toISOString(),
          is_unread: true,
        };
      }

      set((state) => ({
        conversations: [newConversation, ...state.conversations],
        selectedConversationId: newConversation.id,
      }));
      return newConversation;
    },

    renameConversation: async (conversationId, title) => {
      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.renameConversation(conversationId, title);
      }
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, title } : conv
        ),
      }));
    },

    deleteConversation: async (conversationId) => {
      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.deleteConversation(conversationId);
      }
      set((state) => {
        const newConversations = state.conversations.filter((c) => c.id !== conversationId);
        const newMessages = state.messages.filter((m) => m.conversation_id !== conversationId);
        const newSelectedId =
          state.selectedConversationId === conversationId
            ? newConversations[0]?.id ?? null
            : state.selectedConversationId;
        return {
          conversations: newConversations,
          messages: newMessages,
          selectedConversationId: newSelectedId,
        };
      });
    },

    markAsRead: (conversationId) =>
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, is_unread: false } : conv
        ),
      })),

    getConversationByTask: (taskId) => {
      const state = get();
      return state.conversations.find((conv) => conv.task_id === taskId);
    },

    getConversationMessages: (conversationId) => {
      const state = get();
      return state.messages.filter((msg) => msg.conversation_id === conversationId);
    },

    sendMessage: async ({ conversationId, content, taskId }) => {
      const { selectedProviderId, selectedModelId, providerConfigs } = useProviderStore.getState();

      if (!selectedProviderId || !selectedModelId) {
        set({ lastError: 'Select a provider and model before sending a message.' });
        return;
      }

      const providerConfig = providerConfigs.find((p) => p.id === selectedProviderId);
      if (!providerConfig) {
        set({ lastError: 'Provider configuration not found.' });
        return;
      }

      const userMessage: ChatMessage = {
        id: `msg-${Date.now()}`,
        task_id: taskId ?? '',
        conversation_id: conversationId,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };

      set({ lastError: null });
      get().addMessage(userMessage);

      // Save user message to DB if available
      if (tauriIpc.isTauriAvailable()) {
        tauriIpc.createMessage(conversationId, 'user', content).catch(console.error);
      }

      const messagesForRequest = prepareMessagesForRequest(conversationId);
      const fileToolContext = useCitationsStore
        .getState()
        .getConversationContextCitations(conversationId)
        .filter((c) => c.type === 'file' || c.type === 'document')
        .map((c) => ({
          title: c.title,
          source: c.source,
          path: c.path,
          snippet: c.snippet,
        }));

      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        task_id: taskId ?? '',
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      };

      get().addMessage(assistantMessage);
      
      const abortController = new AbortController();
      set({ isLoading: true, isStreaming: true, abortController });

      try {
        await streamChat({
          providerId: selectedProviderId,
          providerType: providerConfig.providerType,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          modelId: selectedModelId,
          messages: messagesForRequest,
          fileToolContext,
          signal: abortController.signal,
          onToken: (token) => {
            get().appendToLastMessage(token);
          },
          onComplete: (fullContent) => {
            // Update conversation metadata
            set((state) => {
              const conversations = state.conversations.map((conv) =>
                conv.id === conversationId
                  ? {
                      ...conv,
                      last_message: fullContent.slice(0, 100) + (fullContent.length > 100 ? '...' : ''),
                      updated_at: new Date().toISOString(),
                    }
                  : conv
              );
              return { conversations, isLoading: false, isStreaming: false, abortController: null };
            });

            // Save assistant message to DB if available
            if (tauriIpc.isTauriAvailable()) {
              tauriIpc.createMessage(conversationId, 'assistant', fullContent).catch(console.error);
            }
          },
          onError: (error) => {
            get().updateMessageContent(
              assistantMessage.id,
              `Error: ${error.message}`
            );
            set({ isLoading: false, isStreaming: false, lastError: error.message, abortController: null });
          },
          onToolCall: (toolName, args) => {
            handleToolCall(conversationId, assistantMessage.id, toolName, args);
          },
        });
      } catch (error) {
        const normalized = toServiceError(error);
        get().updateMessageContent(
          assistantMessage.id,
          `Error: ${normalized.message}`
        );
        set({ isLoading: false, isStreaming: false, lastError: normalized.message, abortController: null });
      }
    },

    stopStreaming: () => {
      const { abortController } = get();
      if (abortController) {
        abortController.abort();
      }
      // Cancel the active reader and stream
      cancelStream();
      set({ isStreaming: false, isLoading: false, abortController: null });
    },

    editMessage: async (messageId, newContent) => {
      const { selectedProviderId, selectedModelId, providerConfigs } = useProviderStore.getState();
      if (!selectedProviderId || !selectedModelId) {
        set({ lastError: 'Select a provider and model before sending a message.' });
        return;
      }

      const providerConfig = providerConfigs.find((p) => p.id === selectedProviderId);
      if (!providerConfig) {
        set({ lastError: 'Provider configuration not found.' });
        return;
      }

      const state = get();
      const target = state.messages.find((message) => message.id === messageId);
      if (!target) return;

      const conversationId = target.conversation_id;

      if (tauriIpc.isTauriAvailable()) {
        tauriIpc.deleteMessagesAfter(conversationId, messageId).catch(console.error);
      }

      set((current) => {
        const updatedMessages = current.messages.map((message) =>
          message.id === messageId ? { ...message, content: newContent } : message
        );

        const conversationMessages = updatedMessages
          .filter((message) => message.conversation_id === conversationId)
          .sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );

        const targetIndex = conversationMessages.findIndex(
          (message) => message.id === messageId
        );

        const allowedIds = new Set(
          conversationMessages.slice(0, targetIndex + 1).map((message) => message.id)
        );

        const trimmedMessages = updatedMessages.filter((message) =>
          message.conversation_id === conversationId ? allowedIds.has(message.id) : true
        );

        const conversationMeta = recalcConversation(conversationId, trimmedMessages);

        const conversations = current.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, ...conversationMeta } : conv
        );

        return { messages: trimmedMessages, conversations, lastError: null };
      });

      // Keep manual context, but drop source passages produced by assistant messages that were trimmed.
      const keptConversationMessageIds = get()
        .messages
        .filter((message) => message.conversation_id === conversationId)
        .map((message) => message.id);
      useCitationsStore
        .getState()
        .pruneConversationSourceCitations(conversationId, keptConversationMessageIds);

      const messagesForRequest = prepareMessagesForRequest(conversationId);
      const fileToolContext = useCitationsStore
        .getState()
        .getConversationContextCitations(conversationId)
        .filter((c) => c.type === 'file' || c.type === 'document')
        .map((c) => ({
          title: c.title,
          source: c.source,
          path: c.path,
          snippet: c.snippet,
        }));

      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        task_id: target.task_id,
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      };

      get().addMessage(assistantMessage);
      
      const abortController = new AbortController();
      set({ isLoading: true, isStreaming: true, abortController });

      try {
        await streamChat({
          providerId: selectedProviderId,
          providerType: providerConfig.providerType,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          modelId: selectedModelId,
          messages: messagesForRequest,
          fileToolContext,
          signal: abortController.signal,
          onToken: (token) => {
            get().appendToLastMessage(token);
          },
          onComplete: (fullContent) => {
            set((state) => {
              const conversations = state.conversations.map((conv) =>
                conv.id === conversationId
                  ? {
                      ...conv,
                      last_message: fullContent.slice(0, 100) + (fullContent.length > 100 ? '...' : ''),
                      updated_at: new Date().toISOString(),
                    }
                  : conv
              );
              return { conversations, isLoading: false, isStreaming: false, abortController: null };
            });
          },
          onError: (error) => {
            get().updateMessageContent(
              assistantMessage.id,
              `Error: ${error.message}`
            );
            set({ isLoading: false, isStreaming: false, lastError: error.message, abortController: null });
          },
          onToolCall: (toolName, args) => {
            handleToolCall(conversationId, assistantMessage.id, toolName, args);
          },
        });
      } catch (error) {
        const normalized = toServiceError(error);
        get().updateMessageContent(
          assistantMessage.id,
          `Error: ${normalized.message}`
        );
        set({ isLoading: false, isStreaming: false, lastError: normalized.message, abortController: null });
      }
    },

    initialize: async () => {
      set({ isLoading: true, lastError: null });
      try {
        // Try to load from Tauri DB if available
        if (tauriIpc.isTauriAvailable()) {
          const dbConversations = await tauriIpc.listConversations();
          const conversations: Conversation[] = dbConversations.map((c) => ({
            id: c.id,
            title: c.title,
            task_id: null,
            project_id: null,
            last_message: c.last_message || '',
            message_count: c.message_count,
            updated_at: c.updated_at,
            is_unread: false,
          }));

          // Load messages for all conversations
          const allMessages: ChatMessage[] = [];
          for (const conv of dbConversations) {
            const dbMessages = await tauriIpc.listMessages(conv.id);
            allMessages.push(
              ...dbMessages.map((m) => ({
                id: m.id,
                task_id: '',
                conversation_id: m.conversation_id,
                role: m.role as 'user' | 'assistant',
                content: m.content,
                timestamp: m.created_at,
              }))
            );
          }

          set({
            conversations,
            messages: allMessages,
            selectedConversationId: conversations[0]?.id ?? null,
            isLoading: false,
          });
        } else {
          // Development mode without Tauri - start with empty state
          set({
            conversations: [],
            messages: [],
            selectedConversationId: null,
            isLoading: false,
          });
        }
      } catch (error) {
        const normalized = toServiceError(error);
        console.error('Failed to initialize chat store:', normalized.message);
        // Fallback to empty state
        set({
          conversations: [],
          messages: [],
          selectedConversationId: null,
          isLoading: false,
          lastError: normalized.message,
        });
      }
    },
  };
});
