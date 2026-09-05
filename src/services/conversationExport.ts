import type { Citation } from '../stores/useCitationsStore';
import type { MessageImageAttachment } from '../stores/useChatStore';
import type { ChatMessage, Conversation, PersistedContextReference, ToolTrace } from '../types';

export interface ConversationExportMessage extends ChatMessage {
  images: MessageImageAttachment[];
}

interface ConversationMarkdownExportInput {
  conversation: Conversation;
  messages: ConversationExportMessage[];
  citations: Citation[];
  exportedAt: string;
}

const escapeMarkdownText = (value: string): string =>
  value
    .replace(/([\\`*_{}<>#+.!|])/g, '\\$1')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');

const inlineCode = (value: string): string => {
  value = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
};

const quoteMarkdown = (value: string): string => {
  if (!value) return '> _No text content._';
  return value.split('\n').map((line) => `> ${line}`).join('\n');
};

const formatBytes = (value?: number): string => {
  if (typeof value !== 'number') return 'size unavailable';
  if (value < 1024) return `${value} B`;
  const sizeKb = value / 1024;
  return sizeKb < 1024 ? `${sizeKb.toFixed(1)} KB` : `${(sizeKb / 1024).toFixed(1)} MB`;
};

const formatContextReference = (ref: PersistedContextReference): string => {
  const kind = ref.kind.replace('-', ' ');
  const location = ref.path ?? ref.relativePath ?? ref.url;
  const suffix = location ? `, ${inlineCode(location)}` : '';
  const availability = ref.kind === 'file'
    ? 'workspace reference, content not embedded in this export'
    : 'reference metadata available';
  return `- ${kind}: ${inlineCode(ref.title)}${suffix}. ${availability}.`;
};

const formatToolTrace = (trace: ToolTrace): string[] => {
  const timing = typeof trace.completed_at_ms === 'number' && typeof trace.started_at_ms === 'number'
    ? `, ${Math.max(0, trace.completed_at_ms - trace.started_at_ms)} ms`
    : '';
  const lines = [`- ${inlineCode(trace.tool_name)}: ${trace.status}${timing}`];
  if (trace.detail) {
    lines.push(...trace.detail.split('\n').map((line) => `  > ${line}`));
  } else {
    lines.push('  > Detail unavailable.');
  }
  return lines;
};

export const buildConversationMarkdownExport = ({
  conversation,
  messages,
  citations,
  exportedAt,
}: ConversationMarkdownExportInput): string => {
  const lines = [
    `# ${escapeMarkdownText(conversation.title)}`,
    '',
    `- Exported: ${exportedAt}`,
    `- Mode: ${conversation.scope_mode}`,
    `- Conversation ID: ${inlineCode(conversation.id)}`,
    '',
    '## Conversation attachments',
    '',
  ];

  const fileCitations = citations.filter(
    (citation) => citation.scope === 'context' && citation.type === 'file',
  );
  if (fileCitations.length === 0) {
    lines.push('_No conversation files._');
  } else {
    fileCitations.forEach((citation) => {
      const availability = typeof citation.content === 'string'
        ? 'content available in the conversation context'
        : 'content unavailable in this export';
      lines.push(
        `- ${inlineCode(citation.title)} (${formatBytes(citation.sizeBytes)}). ${availability}.`,
      );
    });
  }

  lines.push('', '## Messages', '');
  if (messages.length === 0) {
    lines.push('_No messages._', '');
  }

  messages.forEach((message, index) => {
    const role = message.role === 'user' ? 'User' : 'Assistant';
    lines.push(`### ${index + 1}. ${role}`, '', `_${message.timestamp}_`, '');
    lines.push(quoteMarkdown(message.content), '');

    if (message.context_refs?.length) {
      lines.push('#### Context references', '');
      message.context_refs.forEach((ref) => lines.push(formatContextReference(ref)));
      lines.push('');
    }

    if (message.images.length > 0) {
      lines.push('#### Image attachments', '');
      message.images.forEach((image, imageIndex) => {
        const availability = image.dataUrl
          ? 'embedded data available in the JSON export, omitted from Markdown'
          : 'image data unavailable';
        lines.push(`- Image ${imageIndex + 1} (${inlineCode(image.mimeType)}). ${availability}.`);
      });
      lines.push('');
    }

    if (message.tool_traces?.length) {
      lines.push('#### Tools', '');
      message.tool_traces.forEach((trace) => lines.push(...formatToolTrace(trace)));
      lines.push('');
    }
  });

  return `${lines.join('\n').trimEnd()}\n`;
};

export const getConversationExportBaseName = (title: string): string => {
  const normalized = Array.from(title.normalize('NFKC'))
    .map((character) =>
      (character.codePointAt(0) ?? 0) < 32 || '\\/:*?"<>|'.includes(character)
        ? '_'
        : character,
    )
    .join('');
  const sanitized = normalized
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return sanitized || 'conversation';
};
