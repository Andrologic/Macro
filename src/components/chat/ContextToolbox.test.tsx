import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type MockCitation = {
  id: string;
  type: 'web' | 'file' | 'document' | 'source_passage';
  scope: 'context' | 'source';
  source: string;
  title: string;
  snippet?: string;
  content?: string;
  messageId: string;
  conversationId: string;
  timestamp: string;
  url?: string;
  path?: string;
  kind?: 'interesting' | 'used';
  reason?: string;
};

const chatTools = [
  {
    id: 'web_search',
    name: 'Web Search',
    description: 'Search the web',
    category: 'web',
    icon: 'search',
    status: 'enabled',
  },
  {
    id: 'web_fetch',
    name: 'Web Fetch',
    description: 'Fetch a URL',
    category: 'web',
    icon: 'globe',
    status: 'enabled',
  },
  {
    id: 'question',
    name: 'Question',
    description: 'Ask a structured question',
    category: 'ai',
    icon: 'message-circle-question',
    status: 'enabled',
  },
  {
    id: 'read_file',
    name: 'Read File',
    description: 'Read attached files',
    category: 'filesystem',
    icon: 'file-text',
    status: 'enabled',
  },
  {
    id: 'mark_source_passage',
    name: 'Sources',
    description: 'Track source passages',
    category: 'ai',
    icon: 'book-open',
    status: 'enabled',
  },
];

const contextCitations: MockCitation[] = [
  {
    id: 'file-1',
    type: 'file',
    scope: 'context',
    source: 'notes.md',
    title: 'notes.md',
    snippet: 'Attached notes',
    content: 'Attached notes with full body',
    path: 'notes.md',
    messageId: 'manual-file',
    conversationId: 'chat-conv',
    timestamp: '2026-03-19T00:00:00.000Z',
  },
];

const sourceCitations: MockCitation[] = [
  {
    id: 'source-interesting',
    type: 'source_passage',
    scope: 'source',
    source: 'notes.md',
    title: 'Interesting source',
    snippet: 'Macro stores source passages.',
    content: 'Macro stores source passages.',
    messageId: 'assistant-1',
    conversationId: 'chat-conv',
    timestamp: '2026-03-19T00:03:00.000Z',
    kind: 'interesting',
    reason: 'Useful context',
  },
  {
    id: 'source-used',
    type: 'source_passage',
    scope: 'source',
    source: 'https://example.com/source',
    title: 'Used source',
    snippet: 'Macro uses saved citations in answers.',
    content: 'Macro uses saved citations in answers.',
    messageId: 'assistant-2',
    conversationId: 'chat-conv',
    timestamp: '2026-03-19T00:02:00.000Z',
    url: 'https://example.com/source',
    kind: 'used',
  },
];

const enabledToolIds = new Set(chatTools.map((tool) => tool.id));
const addCitationMock = mock(() => 'citation-new');
const removeCitationMock = mock((_id: string) => undefined);
const toggleChatToolMock = mock((_toolId: string) => undefined);
const createConversationMock = mock(async () => ({ id: 'chat-conv' }));
const clipboardWriteTextMock = mock(async (_text: string) => undefined);
const focusEvents: unknown[] = [];
const inputChangeHandlers = new Map<string, (event: React.ChangeEvent<HTMLInputElement>) => void>();

let importCounter = 0;

const textIncludes = (node: Element, text: string) => node.textContent?.includes(text) ?? false;

const findButtonByText = (container: HTMLElement, text: string): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    textIncludes(candidate, text),
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
};

const clickIconButton = async (container: HTMLElement, iconName: string) => {
  const icon = container.querySelector(`[data-icon="${iconName}"]`);
  expect(icon).toBeTruthy();
  const button = icon?.closest('button');
  expect(button).toBeTruthy();
  await act(async () => {
    (button as HTMLButtonElement | null)?.click();
    await Promise.resolve();
  });
};

const loadContextToolbox = async () => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      i18n: { language: 'en', resolvedLanguage: 'en' },
      t: (
        _key: string,
        fallbackOrOptions?: string | { defaultValue?: string },
        maybeOptions?: { defaultValue?: string },
      ) => {
        if (typeof fallbackOrOptions === 'string') return fallbackOrOptions;
        return maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? _key;
      },
    }),
  }));

  mock.module('../../stores/useChatStore', () => ({
    useChatStore: () => ({
      selectedConversationId: 'chat-conv',
      createConversation: createConversationMock,
    }),
  }));

  mock.module('../../stores/useCitationsStore', () => ({
    useCitationsStore: () => ({
      getConversationContextCitations: () => contextCitations,
      getConversationInterestingSourceCitations: () =>
        sourceCitations.filter((citation) => citation.kind === 'interesting'),
      getConversationUsedSourceCitations: () =>
        sourceCitations.filter((citation) => citation.kind !== 'interesting'),
      addCitation: addCitationMock,
      removeCitation: removeCitationMock,
    }),
  }));

  mock.module('../../stores/useProviderStore', () => ({
    useProviderStore: (selector?: (state: { selectedSupportsNativeToolCalling: () => boolean }) => unknown) => {
      const state = { selectedSupportsNativeToolCalling: () => true };
      return selector ? selector(state) : state;
    },
  }));

  mock.module('../../stores/useToolsStore', () => ({
    useToolsStore: () => ({
      getChatModeTools: () => chatTools,
      isChatToolEnabled: (toolId: string) => enabledToolIds.has(toolId),
      toggleChatTool: toggleChatToolMock,
    }),
  }));

  mock.module('../../services/webSearch', () => ({
    extractDomain: (url: string) => new URL(url).hostname,
    fetchWebPage: mock(async (url: string) => ({
      url,
      title: 'Fetched page',
      snippet: 'Fetched snippet',
      content: 'Fetched full content',
    })),
    getFaviconUrl: (url: string) => `${url}/favicon.ico`,
  }));

  mock.module('../../services/webSearchSettings', () => ({
    getWebSearchSettings: () => ({
      provider: 'tavily',
      tavilyApiKey: 'tvly-test',
      braveApiKey: '',
      enabled: true,
      fetchEnabled: true,
    }),
  }));

  mock.module('../../i18n/format', () => ({
    compareLocalized: (left: string, right: string) => left.localeCompare(right),
    formatRelativeTimeShort: () => 'just now',
  }));

  mock.module('../../utils/cn', () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }));

  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../ui/Input', () => ({
    Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean }>(
      ({ onChange, error: _error, ...props }, ref) => (
        (() => {
          if (typeof props.placeholder === 'string' && onChange) {
            inputChangeHandlers.set(props.placeholder, onChange);
          }
          return (
            <input
              ref={ref}
              {...props}
              onChange={onChange}
              onInput={(event) => onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>)}
            />
          );
        })()
      ),
    ),
  }));

  mock.module('../ui/Switch', () => ({
    Switch: ({
      checked,
      disabled,
      onCheckedChange,
    }: {
      checked?: boolean;
      disabled?: boolean;
      onCheckedChange?: (checked: boolean) => void;
    }) => (
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(checked)}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
      />
    ),
  }));

  importCounter += 1;
  return import(`./ContextToolbox.tsx?context-toolbox-test=${importCounter}`);
};

describe('ContextToolbox', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    focusEvents.length = 0;
    inputChangeHandlers.clear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: mock(async () => 'clipboard text'),
        writeText: clipboardWriteTextMock,
      },
    });
    window.addEventListener('macro:focus-message', (event) => {
      focusEvents.push((event as CustomEvent).detail);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    container = null;
    root = null;
    clipboardWriteTextMock.mockClear();
    addCitationMock.mockClear();
    removeCitationMock.mockClear();
    toggleChatToolMock.mockClear();
    mock.restore();
  });

  it('keeps Context, Tools, and Sources usable without dead Screenshot or MCP entries', async () => {
    const { ContextToolbox } = await loadContextToolbox();

    await act(async () => {
      root?.render(<ContextToolbox />);
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Context');
    expect(container?.textContent).toContain('Tools');
    expect(container?.textContent).toContain('Sources');
    expect(container?.textContent).toContain('Upload');
    expect(container?.textContent).toContain('Add URL');
    expect(container?.textContent).toContain('Paste');
    expect(container?.textContent).not.toContain('Screenshot');
    expect(container?.textContent).not.toContain('MCP Servers');
    expect(container?.textContent).not.toContain('No MCP servers connected');

    await act(async () => {
      findButtonByText(container!, 'Tools').click();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Built-in Tools');
    for (const label of ['Web Search', 'Web Fetch', 'Question', 'Read File', 'Sources']) {
      expect(container?.textContent).toContain(label);
    }
    for (const label of ['Read Sources', 'Edit Sources', 'List Files', 'Terminal', 'Need', 'Plan']) {
      expect(container?.textContent).not.toContain(label);
    }
    expect(container?.querySelectorAll('[role="switch"]').length).toBe(5);

    await act(async () => {
      findButtonByText(container!, 'Sources').click();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Interesting source');
    expect(container?.textContent).toContain('Used source');
    expect(container?.textContent).toContain('Found');
    expect(container?.textContent).toContain('Used');

    await clickIconButton(container!, 'message-square');
    expect(focusEvents).toContainEqual({ messageId: 'assistant-1' });

    await clickIconButton(container!, 'copy');
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('Macro stores source passages.');

    const searchInput = container?.querySelector('input[placeholder="Search sources"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();
    const sourceSearchChange = inputChangeHandlers.get('Search sources');
    expect(sourceSearchChange).toBeTruthy();
    await act(async () => {
      sourceSearchChange?.({
        target: { value: 'missing phrase' },
      } as React.ChangeEvent<HTMLInputElement>);
      await Promise.resolve();
    });
    expect(container?.textContent).toContain('No results for this filter');

    await act(async () => {
      sourceSearchChange?.({
        target: { value: '' },
      } as React.ChangeEvent<HTMLInputElement>);
      await Promise.resolve();
    });
    await clickIconButton(container!, 'trash');
    expect(removeCitationMock).toHaveBeenCalledWith('source-interesting');
  });
});
