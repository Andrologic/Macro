import { describe, expect, it } from 'bun:test';
import type { ChatMessage } from '../types';
import { restoreToolApprovalRecovery } from './toolApprovalRecovery';

const marker = JSON.stringify({ version: 1, conversationId: 'conversation', assistantMessageId: 'assistant', toolCallId: 'call' });
const message: ChatMessage = {
  id: 'assistant', conversation_id: 'conversation', role: 'assistant', content: 'Before the request', task_id: '', timestamp: '2026-09-04T00:00:00Z',
  tool_traces: [{ tool_call_id: 'call', tool_name: 'terminal_run', status: 'pending_approval' }],
};

describe('tool approval recovery validation', () => {
  it('requires a matching pending trace in the original conversation', () => {
    expect(restoreToolApprovalRecovery(marker, 'other', [message])).toBeNull();
    expect(restoreToolApprovalRecovery(marker, 'conversation', [])).toBeNull();
    expect(restoreToolApprovalRecovery(marker, 'conversation', [{ ...message, tool_traces: [{ tool_call_id: 'call', tool_name: 'terminal_run', status: 'done' }] }])).toBeNull();
    expect(restoreToolApprovalRecovery(marker, 'conversation', [message])?.recoveryState).toBe('interrupted');
    expect(restoreToolApprovalRecovery(marker, 'conversation', [{ ...message, tool_traces: [{ tool_call_id: 'call', tool_name: 'terminal_run', status: 'denied' }] }])?.recoveryState).toBe('interrupted');
  });
  it('invalidates an old marker after a later user turn and rejects unknown formats', () => {
    expect(restoreToolApprovalRecovery(marker, 'conversation', [message, { ...message, id: 'next', role: 'user' }])).toBeNull();
    expect(restoreToolApprovalRecovery('{', 'conversation', [message])).toBeNull();
    expect(restoreToolApprovalRecovery(marker.replace('"version":1', '"version":2'), 'conversation', [message])).toBeNull();
  });
});
