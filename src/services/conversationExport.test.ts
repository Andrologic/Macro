import { describe, expect, it } from 'bun:test';
import type { ConversationExportMessage } from './conversationExport';
import {
  buildConversationMarkdownExport,
  getConversationExportBaseName,
} from './conversationExport';

describe('conversationExport', () => {
  it('renders messages, tool details, Markdown characters, and attachment states readably', () => {
    const messages: ConversationExportMessage[] = [{
      id: 'message-1',
      task_id: 'task-1',
      conversation_id: 'conversation-1',
      role: 'user',
      content: '# Keep *this* Markdown\nA | B',
      timestamp: '2026-09-05T10:00:00.000Z',
      context_refs: [{
        id: 'file-ref',
        kind: 'file',
        title: 'strange`name[1].md',
        path: 'docs/strange`name[1].md',
      }],
      tool_traces: [{
        tool_call_id: 'tool-1',
        tool_name: 'read_file',
        status: 'done',
        detail: 'Read 12 lines\nNo errors',
      }],
      images: [{
        id: 'image-1',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
        createdAt: '2026-09-05T10:00:00.000Z',
      }],
    }];

    const markdown = buildConversationMarkdownExport({
      conversation: {
        id: 'conversation-1',
        title: 'Title #1',
        scope_mode: 'Chat',
        task_id: null,
        project_id: null,
        last_message: '',
        message_count: 1,
        updated_at: '2026-09-05T10:00:00.000Z',
        is_unread: false,
      },
      messages,
      citations: [{
        id: 'citation-1',
        type: 'file',
        scope: 'context',
        source: 'notes_[draft].md',
        title: 'notes_[draft].md',
        messageId: 'manual-1',
        conversationId: 'conversation-1',
        timestamp: '2026-09-05T10:00:00.000Z',
        sizeBytes: 42,
      }],
      exportedAt: '2026-09-05T11:00:00.000Z',
    });

    expect(markdown).toContain('# Title \\#1');
    expect(markdown).toContain('> # Keep *this* Markdown');
    expect(markdown).toContain('`notes_[draft].md` (42 B). content unavailable in this export.');
    expect(markdown).toContain('``strange`name[1].md``');
    expect(markdown).toContain('workspace reference, content not embedded in this export');
    expect(markdown).toContain('`read_file`: done');
    expect(markdown).toContain('  > Read 12 lines');
    expect(markdown).toContain('embedded data available in the JSON export, omitted from Markdown');
  });

  it('creates filesystem-safe names without losing a useful title', () => {
    expect(getConversationExportBaseName('Review: `a/b` * draft?')).toBe('Review_`a_b`_draft');
    expect(getConversationExportBaseName('///')).toBe('conversation');
  });
});
