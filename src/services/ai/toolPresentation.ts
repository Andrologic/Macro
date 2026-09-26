const escapeToolContextAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const formatToolTraceDetail = (toolName: string, args: Record<string, unknown>): string | undefined => {
  if (toolName === 'web_search') {
    return typeof args.query === 'string' ? args.query : undefined;
  }

  if (toolName === 'web_fetch') {
    return typeof args.url === 'string' ? args.url : undefined;
  }

  if (toolName === 'mark_source_passage') {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
    if (title && kind) return `${title}, kind=${kind}`;
    return title || kind || undefined;
  }

  if (toolName === 'read_sources') {
    const parts = [
      typeof args.kind === 'string' && args.kind.trim() ? `kind=${args.kind.trim()}` : '',
      typeof args.query === 'string' && args.query.trim() ? `query=${args.query.trim()}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }

  if (toolName === 'edit_source_passage') {
    const parts = [
      typeof args.citation_id === 'string' && args.citation_id.trim()
        ? `id=${args.citation_id.trim()}`
        : '',
      typeof args.action === 'string' && args.action.trim() ? `action=${args.action.trim()}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }

  if (toolName === 'read_file') {
    const file = typeof args.file === 'string' ? args.file.trim() : '';
    const extractText = args.extract_text === true ? 'extract_text=true' : '';
    return [file, extractText].filter(Boolean).join(', ') || undefined;
  }

  if (
    toolName === 'list' ||
    toolName === 'read' ||
    toolName === 'write' ||
    toolName === 'edit' ||
    toolName === 'delete'
  ) {
    return typeof args.path === 'string' ? args.path.trim() : undefined;
  }

  if (toolName === 'glob') {
    return typeof args.pattern === 'string' ? args.pattern.trim() : undefined;
  }

  if (toolName === 'grep') {
    return typeof args.query === 'string' ? args.query.trim() : undefined;
  }

  if (toolName === 'terminal_create_session') {
    return typeof args.cwd === 'string' ? args.cwd.trim() : undefined;
  }

  if (toolName === 'terminal_run') {
    return typeof args.command === 'string' ? args.command.trim() : undefined;
  }

  if (toolName === 'question') {
    const questions = Array.isArray(args.questions) ? args.questions.length : 0;
    return questions > 0 ? `${questions} question${questions > 1 ? 's' : ''}` : undefined;
  }

  return undefined;
};

export const formatToolUsageLabel = (toolName: string, args: Record<string, unknown>) => {
  const detail = formatToolTraceDetail(toolName, args);
  return detail ? `\n\n[TOOL] ${toolName} (${detail})\n` : `\n\n[TOOL] ${toolName}\n`;
};

export const buildToolContextBlock = (
  toolCallId: string,
  toolName: string,
  detail: string | undefined,
  result: string
): string | null => {
  if (!result.trim()) return null;
  const attrs = [
    `tool_call_id="${escapeToolContextAttribute(toolCallId)}"`,
    `tool="${escapeToolContextAttribute(toolName)}"`,
    detail ? `detail="${escapeToolContextAttribute(detail)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<tool_context ${attrs}>\n${result}\n</tool_context>`;
};
