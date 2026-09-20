import { webSearch, fetchWebPage, formatSearchResultsAsContext } from '../webSearch';
import { formatConversationFilePage } from '../conversationFileTool';
import type { StreamingChatOptions, ToolCallResolution, ToolResult } from './contracts';
import { normalizeToolCallResolution, throwIfToolAborted } from './toolCallResolution';

/** Compatibility tools for callers without a Chat-owned handler. */
export async function executeFallbackTool(params: {
  name: string; args: Record<string, unknown>; callId: string;
  options: StreamingChatOptions; allowedTools: ReadonlySet<string>;
  appendSystemChunk(chunk: string): void;
}): Promise<ToolCallResolution> {
  const { name, args, callId, options, allowedTools, appendSystemChunk } = params;
  const { enableWebSearch = true, enableWebFetch = true, webSearchOptions, signal, onToolCall, fileToolContext = [] } = options;
  throwIfToolAborted(signal);
  if (name === 'web_search') {
    if (!enableWebSearch || (!webSearchOptions?.configured && !webSearchOptions?.tavilyApiKey && !webSearchOptions?.braveApiKey)) {
      return { kind: 'result', result: 'Web search is not configured for this provider.', isError: true, errorKind: 'execution' };
    }
    const results = await webSearch(typeof args.query === 'string' ? args.query : '', { ...webSearchOptions, signal });
    throwIfToolAborted(signal);
    if (options.showToolTraces) appendSystemChunk(`\n\n🔍 **Recherche web:** "${args.query}"\n`);
    return { kind: 'result', result: formatSearchResultsAsContext(results) };
  }
  if (name === 'web_fetch') {
    if (!enableWebFetch) return { kind: 'result', result: 'Web fetch is disabled for this provider.', isError: true, errorKind: 'permission' };
    const url = typeof args.url === 'string' ? args.url : '';
    if (!url.trim()) return { kind: 'result', result: 'Missing URL for web_fetch.' };
    const page = await fetchWebPage(url, signal);
    throwIfToolAborted(signal);
    return { kind: 'result', result: `TITLE: ${page.title}\nURL: ${page.url}\n\n${page.content}` };
  }
  if (name === 'read_sources') return { kind: 'result', result: 'No source passages available.' };
  if (name === 'edit_source_passage') return { kind: 'result', result: 'Source passage edit request processed.' };
  if (name === 'mark_source_passage') return { kind: 'result', result: 'Error executing tool mark_source_passage: source tracking is unavailable in this context.', isError: true, errorKind: 'execution' };
  if (name !== 'read_file') return { kind: 'result', result: `Unsupported tool: ${name}`, isError: true, errorKind: 'execution' };

  let toolResult = '';
  let toolErrorKind: ToolResult['error_kind'];
  const normalizeMatch = (value?: string) =>
    (value || '')
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

  const requestedRaw = typeof args.file === 'string' ? args.file.trim() : '';
  const requested = normalizeMatch(requestedRaw);
  const extractText = args.extract_text === true;
  const available = fileToolContext.map((f) => f.path || f.title || f.source).filter(Boolean);
  let workspaceReadAttempted = false;
  const workspaceMode = allowedTools.has('read') || allowedTools.has('list');

  if (requestedRaw && allowedTools.has('read') && onToolCall) {
    workspaceReadAttempted = true;
    const rawWorkspaceResult = await onToolCall('read', {
      path: requestedRaw,
      start_line: typeof args.start_line === 'number' ? args.start_line : undefined,
      end_line: typeof args.end_line === 'number' ? args.end_line : undefined,
      max_lines: typeof args.max_lines === 'number' ? args.max_lines : undefined,
      cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
    }, callId);
    throwIfToolAborted(signal);
    const normalized = normalizeToolCallResolution(rawWorkspaceResult);
    const isLegacyReadError = typeof rawWorkspaceResult === 'string' && (
      /^Error executing read:/i.test(rawWorkspaceResult) ||
      /^Missing\s+/i.test(rawWorkspaceResult) ||
      /^No match found/i.test(rawWorkspaceResult) ||
      /^File not found/i.test(rawWorkspaceResult) ||
      /^Cannot\s+/i.test(rawWorkspaceResult)
    );
    // An explicit result, including an empty string, is not a missing result.
    if (normalized && !isLegacyReadError) return normalized;

    if (isLegacyReadError) {
      toolResult = `Error executing tool read_file: ${rawWorkspaceResult}`;
      toolErrorKind = 'execution';
    } else {
      toolResult = 'Error executing tool read_file: workspace read returned no content.';
      toolErrorKind = 'execution';
    }
  }

  if (!toolResult.trim()) {
    if (workspaceReadAttempted) {
      toolResult = `Error executing tool read_file: unable to read "${requestedRaw}" from workspace.`;
      toolErrorKind = 'execution';
    } else if (workspaceMode) {
      toolResult =
        `Error executing tool read_file: workspace read tool is unavailable for "${requestedRaw}".` +
        ' Use the read tool directly with an explicit path.';
      toolErrorKind = 'permission';
    } else {
      const contextMatch = fileToolContext.find((file) => {
        const title = normalizeMatch(file.title);
        const source = normalizeMatch(file.source);
        const path = normalizeMatch(file.path);
        return (
          requested === title ||
          requested === source ||
          requested === path ||
          title.includes(requested) ||
          source.includes(requested) ||
          path.includes(requested)
        );
      });

      if (!requested) {
        toolResult = `No file provided. Available files: ${available.join(', ') || 'none'}`;
      } else if (!contextMatch) {
        toolResult = `File not found in context: "${requestedRaw}". Available files: ${available.join(', ') || 'none'}`;
        toolErrorKind = 'execution';
      } else {
        const label = contextMatch.path || contextMatch.title || contextMatch.source;
        const content = (contextMatch.content || contextMatch.snippet || '').trim();
        const isDocx = /\.docx$/i.test(label || '');
        const extractNotice =
          extractText && isDocx
            ? 'Note: extract_text=true requested. Rich DOCX extraction is not available in this build; using available context text.'
            : '';

        toolResult = content
          ? formatConversationFilePage({
              label,
              source: 'CONTEXT_SNIPPET',
              content,
              args,
              notice: extractNotice,
            })
          : `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\nNo textual content available for this file in context.${extractNotice ? `\n\n${extractNotice}` : ''}`;
      }
    }
  }
  return { kind: 'result', result: toolResult, isError: Boolean(toolErrorKind), ...(toolErrorKind ? { errorKind: toolErrorKind } : {}) };
}
