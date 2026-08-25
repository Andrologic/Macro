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
  favicon?: string;
  path?: string;
  sizeBytes?: number;
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
    id: 'terminal_create_session',
    name: 'Terminal',
    description: 'Run individually approved commands',
    category: 'terminal',
    icon: 'terminal',
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

const createInitialContextCitations = (): MockCitation[] => [
  {
    id: 'file-1',
    type: 'file',
    scope: 'context',
    source: 'notes.md',
    title: 'notes.md',
    snippet: 'Attached notes',
    content: 'Attached notes with full body',
    path: 'notes.md',
    sizeBytes: 24,
    messageId: 'manual-file',
    conversationId: 'chat-conv',
    timestamp: '2026-03-19T00:00:00.000Z',
  },
];

const createInitialSourceCitations = (): MockCitation[] => [
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
let contextCitations: MockCitation[] = createInitialContextCitations();
let sourceCitations: MockCitation[] = createInitialSourceCitations();
let selectedConversationIdMock: string | null = 'chat-conv';
let composerContextRefs: Array<{
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  data: MockCitation;
}> = [];
let citationCounter = 0;
let citationVersion = 0;
const citationSubscribers = new Set<() => void>();

const emitCitationChange = () => {
  citationVersion += 1;
  citationSubscribers.forEach((listener) => listener());
};

const addCitationMock = mock((citation: Omit<MockCitation, 'id' | 'timestamp'>) => {
  const existing = contextCitations.find((candidate) => {
    if (candidate.conversationId !== citation.conversationId) return false;
    if (candidate.scope !== citation.scope || candidate.type !== citation.type) return false;
    if (citation.type === 'web') return (candidate.url || candidate.source) === (citation.url || citation.source);
    if (citation.type === 'file') return (candidate.path || candidate.source) === (citation.path || citation.source);
    return false;
  });
  if (existing) {
    contextCitations = contextCitations.map((candidate) =>
      candidate.id === existing.id
        ? {
            ...candidate,
            ...citation,
            id: candidate.id,
            timestamp: new Date().toISOString(),
          }
        : candidate,
    );
    emitCitationChange();
    return existing.id;
  }
  const id = `citation-new-${++citationCounter}`;
  contextCitations = [
    ...contextCitations,
    {
      ...citation,
      id,
      timestamp: new Date().toISOString(),
    },
  ];
  emitCitationChange();
  return id;
});
const removeCitationMock = mock((id: string) => {
  contextCitations = contextCitations.filter((citation) => citation.id !== id);
  sourceCitations = sourceCitations.filter((citation) => citation.id !== id);
  emitCitationChange();
});
const getConversationContextCitationsMock = (conversationId: string) =>
  contextCitations.filter((citation) => citation.conversationId === conversationId);
const getConversationInterestingSourceCitationsMock = (conversationId: string) =>
  sourceCitations.filter(
    (citation) =>
      citation.conversationId === conversationId &&
      citation.kind === 'interesting',
  );
const getConversationUsedSourceCitationsMock = (conversationId: string) =>
  sourceCitations.filter(
    (citation) =>
      citation.conversationId === conversationId &&
      citation.kind !== 'interesting',
  );
const getMockCitationState = () => ({
  citations: [...contextCitations, ...sourceCitations],
  getConversationContextCitations: getConversationContextCitationsMock,
  getConversationInterestingSourceCitations: getConversationInterestingSourceCitationsMock,
  getConversationUsedSourceCitations: getConversationUsedSourceCitationsMock,
  addCitation: addCitationMock,
  removeCitation: removeCitationMock,
});
const toggleChatToolMock = mock((_toolId: string) => undefined);
const createConversationMock = mock(async () => ({ id: 'chat-conv' }));
const addComposerContextRefMock = mock((ref: {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  data: MockCitation;
}) => {
  if (!composerContextRefs.some((candidate) => candidate.id === ref.id && candidate.kind === ref.kind)) {
    composerContextRefs = [...composerContextRefs, ref];
  }
});
const removeComposerContextRefMock = mock((id: string, kind: string) => {
  composerContextRefs = composerContextRefs.filter(
    (ref) => ref.id !== id || ref.kind !== kind,
  );
});
const clipboardWriteTextMock = mock(async (_text: string) => undefined);
const notifyErrorMock = mock((_title: string, _options?: unknown) => undefined);
let clipboardReadTextMock = mock(async () => 'clipboard text');
let fetchWebPageShouldFail = false;
let webFetchEnabledMock = true;
const fetchWebPageMock = mock(async (url: string) => {
  if (fetchWebPageShouldFail) {
    throw new Error('preview failed');
  }
  const isSecond = url.includes('second');
  const favicon = isSecond
    ? 'data:image/png;base64,c2Vjb25kLWljb24='
    : 'data:image/png;base64,aWNvbg==';
  return {
    url,
    title: isSecond ? 'Second fetched page' : 'Fetched page',
    snippet: isSecond ? 'Second fetched snippet' : 'Fetched snippet',
    content: isSecond ? 'Second fetched full content' : 'Fetched full content',
    favicon,
  };
});
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

const findButtonByExactText = (container: HTMLElement, text: string): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
};

const changeInputByPlaceholder = async (placeholder: string, value: string) => {
  const handler = inputChangeHandlers.get(placeholder);
  expect(handler).toBeTruthy();
  await act(async () => {
    handler?.({
      target: { value },
    } as React.ChangeEvent<HTMLInputElement>);
    await Promise.resolve();
  });
};

const uploadFile = async (container: HTMLElement, fileOrFiles: File | File[]) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
  expect(reactPropsKey).toBeTruthy();
  const onChange = (input as unknown as Record<string, { onChange?: (event: unknown) => void }>)[
    reactPropsKey!
  ]?.onChange;
  expect(onChange).toBeTruthy();
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  await act(async () => {
    onChange?.({ target: { files } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const clickActionForText = async (
  container: HTMLElement,
  text: string,
  iconName: string,
) => {
  const button = Array.from(container.querySelectorAll(`[data-icon="${iconName}"]`))
    .map((icon) => icon.closest('button'))
    .find((candidate) => {
      let node: Element | null | undefined = candidate?.parentElement;
      while (node && node !== container) {
        const className = typeof node.className === 'string' ? node.className : '';
        if (
          className.includes('rounded') &&
          className.includes('border') &&
          node.textContent?.includes(text)
        ) return true;
        node = node?.parentElement;
      }
      return false;
    });
  expect(button).toBeTruthy();
  await act(async () => {
    (button as HTMLButtonElement | null)?.click();
    await Promise.resolve();
  });
};

const findCardForText = (container: HTMLElement, text: string): HTMLElement => {
  const match = Array.from(container.querySelectorAll('p, h3, span')).find(
    (node) => node.textContent?.trim() === text,
  );
  expect(match).toBeTruthy();
  let node: Element | null | undefined = match;
  while (node && node !== container) {
    const className = typeof node.className === 'string' ? node.className : '';
    if (className.includes('rounded') && className.includes('hover:bg-accent')) {
      return node as HTMLElement;
    }
    node = node.parentElement;
  }
  throw new Error(`Card not found for ${text}`);
};

const findImageBySrc = (container: HTMLElement, src: string): HTMLImageElement | null =>
  Array.from(container.querySelectorAll('img')).find(
    (image) => image.getAttribute('src') === src,
  ) ?? null;

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
      selectedConversationId: selectedConversationIdMock,
      createConversation: createConversationMock,
      composerContextRefs,
      addComposerContextRef: addComposerContextRefMock,
      removeComposerContextRef: removeComposerContextRefMock,
    }),
  }));

  mock.module('../../stores/useCitationsStore', () => ({
    useCitationsStore: (selector?: (state: ReturnType<typeof getMockCitationState>) => unknown) => {
      React.useSyncExternalStore(
        (listener) => {
          citationSubscribers.add(listener);
          return () => {
            citationSubscribers.delete(listener);
          };
        },
        () => citationVersion,
        () => citationVersion,
      );
      const state = getMockCitationState();
      return selector ? selector(state) : state;
    },
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
    fetchWebPage: fetchWebPageMock,
    getFaviconUrl: (url: string) => `${url}/favicon.ico`,
  }));

  mock.module('../../services/webSearchSettings', () => ({
    getWebSearchSettings: () => ({
      provider: 'tavily',
      tavilyApiKey: 'tvly-test',
      braveApiKey: '',
      enabled: true,
      fetchEnabled: webFetchEnabledMock,
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

  mock.module('../ui/toastService', () => ({
    notify: {
      error: notifyErrorMock,
    },
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
    contextCitations = createInitialContextCitations();
    sourceCitations = createInitialSourceCitations();
    selectedConversationIdMock = 'chat-conv';
    composerContextRefs = [];
    citationCounter = 0;
    citationVersion = 0;
    citationSubscribers.clear();
    fetchWebPageShouldFail = false;
    webFetchEnabledMock = true;
    focusEvents.length = 0;
    inputChangeHandlers.clear();
    clipboardReadTextMock = mock(async () => 'clipboard text');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: clipboardReadTextMock,
        writeText: clipboardWriteTextMock,
      },
    });
    class TestFileReader {
      result: string | null = null;
      error: Error | null = null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsText(file: File) {
        file.text()
          .then((text) => {
            this.result = text;
            this.onload?.({ target: this } as unknown as ProgressEvent<FileReader>);
          })
          .catch((error: Error) => {
            this.error = error;
            this.onerror?.({ target: this } as unknown as ProgressEvent<FileReader>);
          });
      }
    }
    Object.defineProperty(globalThis, 'FileReader', {
      configurable: true,
      value: TestFileReader,
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
    clipboardReadTextMock.mockClear();
    fetchWebPageMock.mockClear();
    notifyErrorMock.mockClear();
    addCitationMock.mockClear();
    removeCitationMock.mockClear();
    addComposerContextRefMock.mockClear();
    removeComposerContextRefMock.mockClear();
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
    expect(container?.textContent).toContain('Paste');
    expect(container?.textContent).toContain('Added links');
    expect(container?.textContent).not.toContain('Add URL');
    expect(container?.querySelector('input[placeholder="https://example.com/article"]')).toBeTruthy();
    expect(container?.textContent).not.toContain('Screenshot');
    expect(container?.textContent).not.toContain('MCP Servers');
    expect(container?.textContent).not.toContain('No MCP servers connected');

    await act(async () => {
      findButtonByText(container!, 'Tools').click();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Built-in Tools');
    expect(container?.querySelector('select[aria-label="Agent workspace"]')).toBeNull();
    for (const label of ['Web Search', 'Web Fetch', 'Question', 'Read File', 'Terminal', 'Sources']) {
      expect(container?.textContent).toContain(label);
    }
    for (const label of ['Read Sources', 'Edit Sources', 'List Files', 'Need', 'Plan']) {
      expect(container?.textContent).not.toContain(label);
    }
    expect(container?.querySelectorAll('[role="switch"]').length).toBe(6);
    expect(
      findCardForText(container!, 'Terminal').querySelector('[role="switch"]')
        ?.hasAttribute('disabled'),
    ).toBe(false);

    await act(async () => {
      findButtonByText(container!, 'Sources').click();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Interesting source');
    expect(container?.textContent).toContain('Used source');
    expect(container?.textContent).toContain('Found');
    expect(container?.textContent).toContain('Used');
    expect(container?.innerHTML).toContain('text-primary');
    expect(container?.innerHTML).not.toContain('amber-');

    const interestingCard = findCardForText(container!, 'Interesting source');
    const sourceToggle = interestingCard.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(sourceToggle).toBeTruthy();
    expect(sourceToggle.getAttribute('aria-expanded')).toBe('false');
    const sourceSnippet = Array.from(interestingCard.querySelectorAll('p')).find(
      (node) => node.textContent === 'Macro stores source passages.',
    );
    expect(sourceSnippet?.className).toContain('line-clamp-2');
    await act(async () => {
      sourceToggle.click();
      await Promise.resolve();
    });
    expect(sourceToggle.getAttribute('aria-expanded')).toBe('true');
    expect(sourceSnippet?.className).toContain('whitespace-pre-wrap');

    await clickActionForText(container!, 'Interesting source', 'plus');
    expect(addComposerContextRefMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'source-interesting',
        kind: 'source',
        title: 'Interesting source',
        subtitle: 'notes.md',
        data: expect.objectContaining({
          id: 'source-interesting',
        }),
      }),
    );

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
    expect(removeComposerContextRefMock).toHaveBeenCalledWith('source-interesting', 'source');
  });

  it('shows source composer references as already added', async () => {
    composerContextRefs = [
      {
        id: 'source-interesting',
        kind: 'source',
        title: 'Interesting source',
        subtitle: 'notes.md',
        data: sourceCitations[0],
      },
    ];
    const { ContextToolbox } = await loadContextToolbox();

    await act(async () => {
      root?.render(<ContextToolbox />);
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(container!, 'Sources').click();
      await Promise.resolve();
    });

    const interestingCard = findCardForText(container!, 'Interesting source');
    const alreadyAddedButton = interestingCard.querySelector('button[title="Already in composer"]') as HTMLButtonElement;
    expect(alreadyAddedButton).toBeTruthy();
    expect(alreadyAddedButton.disabled).toBe(true);
    expect(alreadyAddedButton.querySelector('[data-icon="check"]')).toBeTruthy();
  });

  it('disables Web Fetch in the Chat tools list when URL fetching is disabled globally', async () => {
    webFetchEnabledMock = false;
    const { ContextToolbox } = await loadContextToolbox();

    await act(async () => {
      root?.render(<ContextToolbox />);
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(container!, 'Tools').click();
      await Promise.resolve();
    });

    const webFetchRow = findCardForText(container!, 'Web Fetch');
    expect(webFetchRow.textContent).toContain('Fetch a URL');
    expect(webFetchRow.querySelector('[role="switch"]')?.hasAttribute('disabled')).toBe(true);
    expect(toggleChatToolMock).not.toHaveBeenCalled();
  });

  it('keeps uploaded files visible when the toolbox creates the chat conversation', async () => {
    selectedConversationIdMock = null;
    contextCitations = [];
    const { ContextToolbox } = await loadContextToolbox();

    await act(async () => {
      root?.render(<ContextToolbox />);
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Attached files');
    expect(container?.textContent).not.toContain('upload-from-empty.md');

    await uploadFile(
      container!,
      new File(['Visible after conversation creation.'], 'upload-from-empty.md', {
        type: 'text/markdown',
      }),
    );

    expect(createConversationMock).toHaveBeenCalled();
    expect(container?.textContent).toContain('upload-from-empty.md');
    expect(container?.textContent).not.toContain('Visible after conversation creation.');
    expect(container?.textContent).not.toContain('Delete');
  });

  it('shows multiple uploaded files as separate attached-file rows and removes only the selected one', async () => {
    contextCitations = [];
    const { ContextToolbox } = await loadContextToolbox();

    await act(async () => {
      root?.render(<ContextToolbox />);
      await Promise.resolve();
    });

    await uploadFile(container!, [
      new File(['First body'], 'first.md', { type: 'text/markdown' }),
      new File(['Second body'], 'second.md', { type: 'text/markdown' }),
    ]);

    expect(container?.textContent).toContain('first.md');
    expect(container?.textContent).not.toContain('First body');
    expect(container?.textContent).toContain('second.md');
    expect(container?.textContent).not.toContain('Second body');

    await clickActionForText(container!, 'first.md', 'x');

    expect(removeCitationMock).toHaveBeenCalledWith('citation-new-1');
    expect(container?.textContent).not.toContain('first.md');
    expect(container?.textContent).toContain('second.md');
  });

  it('rejects non-text uploads with an error toast', async () => {
    contextCitations = [];
    const { ContextToolbox } = await loadContextToolbox();

    await act(async () => {
      root?.render(<ContextToolbox />);
      await Promise.resolve();
    });

    await uploadFile(
      container!,
      new File(['%PDF-1.7'], 'contract.pdf', { type: 'application/pdf' }),
    );

    expect(addCitationMock).not.toHaveBeenCalled();
    expect(container?.textContent).not.toContain('contract.pdf');
    expect(notifyErrorMock).toHaveBeenCalledWith(
      'Unsupported file type',
      expect.objectContaining({
        description: expect.stringContaining('Only text-based files are supported'),
      }),
    );
  });

  it('shows uploaded files, URL additions, paste content, and delete actions immediately', async () => {
    const { ContextToolbox } = await loadContextToolbox();

    await act(async () => {
      root?.render(<ContextToolbox />);
      await Promise.resolve();
    });

    await uploadFile(
      container!,
      new File(['Uploaded file full body for context visibility.'], 'upload.md', {
        type: 'text/markdown',
      }),
    );
    expect(addCitationMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'file',
        title: 'upload.md',
        content: 'Uploaded file full body for context visibility.',
        sizeBytes: 47,
      }),
    );
    expect(container?.textContent).not.toContain('File added to context.');
    expect(container?.textContent).toContain('upload.md');
    expect(container?.textContent).toContain('47 B');
    expect(container?.textContent).not.toContain('Uploaded file full body');

    await changeInputByPlaceholder('https://example.com/article', 'example.com/article');
    await act(async () => {
      findButtonByExactText(container!, 'Add').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchWebPageMock).toHaveBeenCalledWith('https://example.com/article');
    expect(addCitationMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'web',
        title: 'Fetched page',
        favicon: 'data:image/png;base64,aWNvbg==',
      }),
    );
    expect(container?.textContent).not.toContain('URL added to context.');
    expect(container?.textContent).toContain('Fetched page');
    expect(container?.textContent).toContain('example.com');
    expect(container?.textContent).not.toContain('Fetched snippet');
    expect(findImageBySrc(container!, 'data:image/png;base64,aWNvbg==')).toBeTruthy();

    await act(async () => {
      findImageBySrc(container!, 'data:image/png;base64,aWNvbg==')?.dispatchEvent(new Event('error'));
      await Promise.resolve();
    });
    expect(findImageBySrc(container!, 'data:image/png;base64,aWNvbg==')).toBeNull();
    expect(findCardForText(container!, 'Fetched page').querySelector('[data-icon="globe"]')).toBeTruthy();

    await changeInputByPlaceholder('https://example.com/article', 'example.com/second');
    await act(async () => {
      findButtonByExactText(container!, 'Add').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchWebPageMock).toHaveBeenCalledWith('https://example.com/second');
    expect(container?.textContent).toContain('Fetched page');
    expect(container?.textContent).toContain('Second fetched page');

    await act(async () => {
      findButtonByText(container!, 'Paste').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboardReadTextMock).toHaveBeenCalled();
    expect(container?.textContent).not.toContain('Clipboard text added to context.');
    expect(container?.textContent).toContain('Clipboard text');
    expect(container?.textContent).not.toContain('clipboard text');

    await clickActionForText(container!, 'upload.md', 'x');
    expect(removeCitationMock).toHaveBeenCalledWith('citation-new-1');
    expect(container?.textContent).not.toContain('upload.md');

    await clickActionForText(container!, 'Fetched page', 'x');
    expect(removeCitationMock).toHaveBeenCalledWith('citation-new-2');
    expect(container?.textContent).not.toContain('Fetched page');
    expect(container?.textContent).toContain('Second fetched page');

    await clickActionForText(container!, 'Second fetched page', 'x');
    expect(removeCitationMock).toHaveBeenCalledWith('citation-new-3');
    expect(container?.textContent).not.toContain('Second fetched page');

    await clickActionForText(container!, 'Clipboard text', 'x');
    expect(removeCitationMock).toHaveBeenCalledWith('citation-new-4');
    expect(container?.textContent).toContain('No pasted text added');
  });

  it('shows a visible URL fallback when preview fetching fails', async () => {
    fetchWebPageShouldFail = true;
    const originalConsoleError = console.error;
    console.error = mock(() => undefined) as never;
    const { ContextToolbox } = await loadContextToolbox();

    try {
      await act(async () => {
        root?.render(<ContextToolbox />);
        await Promise.resolve();
      });

      await changeInputByPlaceholder('https://example.com/article', 'example.net/story');
      await act(async () => {
        findButtonByExactText(container!, 'Add').click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchWebPageMock).toHaveBeenCalledWith('https://example.net/story');
      expect(container?.textContent).not.toContain('URL added without preview.');
      expect(container?.textContent).toContain('example.net');
      expect(container?.textContent).not.toContain('Preview unavailable');
      expect(notifyErrorMock).toHaveBeenCalledWith(
        'Could not fetch URL preview',
        expect.objectContaining({ description: 'https://example.net/story' }),
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('shows an error toast when clipboard paste has no text', async () => {
    clipboardReadTextMock = mock(async () => '');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: clipboardReadTextMock,
        writeText: clipboardWriteTextMock,
      },
    });
    const { ContextToolbox } = await loadContextToolbox();

    await act(async () => {
      root?.render(<ContextToolbox />);
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(container!, 'Paste').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addCitationMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).toHaveBeenCalledWith('Clipboard is empty');
  });
});
