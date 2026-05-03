import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let markdownRendererImportCounter = 0;

const translationMock = {
  t: (
    key: string,
    fallbackOrOptions?: string | { count?: number; defaultValue?: string },
    maybeOptions?: { count?: number; defaultValue?: string }
  ) => {
    const options =
      typeof fallbackOrOptions === 'object'
        ? fallbackOrOptions
        : maybeOptions;

    if (key === 'chat.runningTools') {
      return 'Running tools';
    }
    if (key === 'chat.toolsUsedCount') {
      const count = options?.count ?? 0;
      return `${count} ${count === 1 ? 'tool' : 'tools'} used`;
    }
    if (key === 'chat.tool') {
      return 'Tool';
    }
    if (key === 'chat.thinking') {
      return 'Thinking...';
    }
    if (typeof fallbackOrOptions === 'string') {
      return fallbackOrOptions;
    }
    return options?.defaultValue ?? key;
  },
};

const loadMarkdownRenderer = async () => {
  mock.restore();
  mock.module('react-i18next', () => ({
    useTranslation: () => translationMock,
  }));
  mock.module('./MarkdownRichContent', () => ({
    __esModule: true,
    default: ({ content }: { content: string }) => (
      <div data-testid="markdown-rich-content">{content}</div>
    ),
  }));
  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  markdownRendererImportCounter += 1;
  return import(`./MarkdownRenderer.tsx?test=${markdownRendererImportCounter}`);
};

const getToolNames = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('[data-testid="tool-trace-item"]')).map(
    (element) => element.getAttribute('data-tool-name') || ''
  );

const getToolGroupContainers = (container: HTMLElement): Element[] =>
  Array.from(
    container.querySelectorAll('[data-testid="tool-traces-running"], [data-testid="tool-traces-completed"]')
  );

const getToolItemIconNames = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('[data-testid="tool-trace-item"] [data-icon]')).map(
    (element) => element.getAttribute('data-icon') || ''
  );

const getGroupHeaderIconName = (group: Element | null | undefined): string | null =>
  group?.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null;

describe('MarkdownRenderer tool trace rendering', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    root = null;
    container = null;
    mock.restore();
  });

  it('renders running tools in a dedicated block at the bottom and preserves insertion order', async () => {
    const { MarkdownRenderer } = await loadMarkdownRenderer();

    await act(async () => {
      root?.render(
        <MarkdownRenderer
          content="Assistant response"
          isStreaming
          toolTraces={[
            { tool_call_id: 'call_z', tool_name: 'read', detail: 'README.md', status: 'running' },
            { tool_call_id: 'call_a', tool_name: 'grep', detail: 'src', status: 'running' },
          ]}
        />
      );
      await Promise.resolve();
    });

    const messageRoot = container?.querySelector('.markdown-content');
    expect(messageRoot?.lastElementChild?.getAttribute('data-testid')).toBe('tool-traces-running');
    expect(getGroupHeaderIconName(messageRoot?.lastElementChild)).toBe('tool');
    expect(getToolNames(container!)).toEqual(['read', 'grep']);
    expect(getToolItemIconNames(container!)).toEqual(['file-text', 'search']);
    expect(container?.querySelector('[data-testid="tool-trace-item"]')?.textContent).not.toContain('Tool');
  });

  it('does not move a completed tool while another tool is still running', async () => {
    const { MarkdownRenderer } = await loadMarkdownRenderer();

    await act(async () => {
      root?.render(
        <MarkdownRenderer
          content="Assistant response"
          isStreaming
          toolTraces={[
            { tool_call_id: 'call_1', tool_name: 'read', detail: 'README.md', status: 'running' },
            { tool_call_id: 'call_2', tool_name: 'grep', detail: 'src', status: 'running' },
          ]}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      root?.render(
        <MarkdownRenderer
          content="Assistant response"
          isStreaming
          toolTraces={[
            { tool_call_id: 'call_1', tool_name: 'read', detail: 'README.md', status: 'done' },
            { tool_call_id: 'call_2', tool_name: 'grep', detail: 'src', status: 'running' },
          ]}
        />
      );
      await Promise.resolve();
    });

    expect(getToolNames(container!)).toEqual(['read', 'grep']);
    expect(
      Array.from(container!.querySelectorAll('[data-testid="tool-trace-item"]')).map(
        (element) => element.getAttribute('data-tool-status')
      )
    ).toEqual(['done', 'running']);
  });

  it('compacts completed tools into a collapsed accordion while keeping order', async () => {
    const { MarkdownRenderer } = await loadMarkdownRenderer();

    await act(async () => {
      root?.render(
        <MarkdownRenderer
          content="Assistant response"
          toolTraces={[
            { tool_call_id: 'call_1', tool_name: 'read', detail: 'README.md', status: 'done' },
            { tool_call_id: 'call_2', tool_name: 'grep', detail: 'src', status: 'done' },
          ]}
        />
      );
      await Promise.resolve();
    });

    const trigger = container?.querySelector(
      '[data-testid="tool-traces-completed-trigger"]'
    ) as HTMLButtonElement | null;
    expect(container?.querySelector('[data-testid="tool-traces-completed"]')).not.toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.textContent).toContain('2 tools used');

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(getToolNames(container!)).toEqual(['read', 'grep']);
    expect(getGroupHeaderIconName(container?.querySelector('[data-testid="tool-traces-completed"]'))).toBe('tool');
    expect(getToolItemIconNames(container!)).toEqual(['file-text', 'search']);
  });

  it('renders Copilot final tool traces with the shared structured UI', async () => {
    const { MarkdownRenderer } = await loadMarkdownRenderer();

    await act(async () => {
      root?.render(
        <MarkdownRenderer
          content="Voici l'analyse."
          toolTraces={[
            {
              tool_call_id: 'copilot_read',
              tool_name: 'read',
              detail: 'README.md',
              status: 'done',
            },
          ]}
        />
      );
      await Promise.resolve();
    });

    const trigger = container?.querySelector(
      '[data-testid="tool-traces-completed-trigger"]'
    ) as HTMLButtonElement | null;
    expect(container?.querySelector('[data-testid="tool-traces-completed"]')).not.toBeNull();
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    expect(getToolNames(container!)).toEqual(['read']);
    expect(container?.textContent).toContain('README.md');
  });

  it('splits structured tool traces into multiple groups when new visible content appears', async () => {
    const { MarkdownRenderer } = await loadMarkdownRenderer();
    const content = [
      '<think>First pass</think>',
      'Interim note',
      '<think>Second pass</think>',
      'Final answer',
    ].join('\n');
    const secondGroupOffset = content.indexOf('<think>Second pass</think>');

    await act(async () => {
      root?.render(
        <MarkdownRenderer
          content={content}
          toolTraces={[
            { tool_call_id: 'call_1', tool_name: 'read', detail: 'README.md', status: 'done', visible_offset: 0 },
            { tool_call_id: 'call_2', tool_name: 'grep', detail: 'src', status: 'done', visible_offset: 0 },
            {
              tool_call_id: 'call_3',
              tool_name: 'terminal_run',
              detail: 'bun test',
              status: 'done',
              visible_offset: secondGroupOffset,
            },
          ]}
        />
      );
      await Promise.resolve();
    });

    const groups = getToolGroupContainers(container!);
    expect(groups).toHaveLength(2);

    const triggers = Array.from(
      container!.querySelectorAll('[data-testid="tool-traces-completed-trigger"]')
    ) as HTMLButtonElement[];
    expect(triggers).toHaveLength(2);

    await act(async () => {
      triggers[0]?.click();
      triggers[1]?.click();
      await Promise.resolve();
    });

    const toolNamesByGroup = groups.map((group) =>
      Array.from(group.querySelectorAll('[data-testid="tool-trace-item"]')).map(
        (element) => element.getAttribute('data-tool-name') || ''
      )
    );
    expect(toolNamesByGroup).toEqual([['read', 'grep'], ['terminal_run']]);
    expect(getToolItemIconNames(container!)).toEqual(['file-text', 'search', 'terminal']);
  });

  it('applies the same grouped rendering to legacy TOOL markers', async () => {
    const { MarkdownRenderer } = await loadMarkdownRenderer();
    const content = [
      'Assistant response',
      '[TOOL] read ("README.md")',
      '[TOOL] grep ("src")',
      '[TOOL_DONE] read ("README.md")',
      '[TOOL_DONE] grep ("src")',
    ].join('\n');

    await act(async () => {
      root?.render(<MarkdownRenderer content={content} isStreaming />);
      await Promise.resolve();
    });

    const trigger = container?.querySelector(
      '[data-testid="tool-traces-completed-trigger"]'
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    expect(getToolNames(container!)).toEqual(['read', 'grep']);
    expect(getToolItemIconNames(container!)).toEqual(['file-text', 'search']);
  });

  it('falls back to the generic tool icon for unknown tool traces', async () => {
    const { MarkdownRenderer } = await loadMarkdownRenderer();

    await act(async () => {
      root?.render(
        <MarkdownRenderer
          content="Assistant response"
          isStreaming
          toolTraces={[
            {
              tool_call_id: 'call_unknown',
              tool_name: 'external_tool',
              status: 'running',
            },
          ]}
        />
      );
      await Promise.resolve();
    });

    const group = container?.querySelector('[data-testid="tool-traces-running"]');
    expect(getGroupHeaderIconName(group)).toBe('tool');
    expect(getToolNames(container!)).toEqual(['external_tool']);
    expect(getToolItemIconNames(container!)).toEqual(['tool']);
  });
});
