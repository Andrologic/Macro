import { describe, expect, it } from 'bun:test';
import { buildArchitectPlanConversationTranscriptParams } from './architectPlanReadService';
import type { ArchitectPlanActivationPayload } from './architectPlanService';

const payload = (overrides: Partial<ArchitectPlanActivationPayload> = {}): ArchitectPlanActivationPayload => ({
  plan: { id: 'plan-1' } as ArchitectPlanActivationPayload['plan'],
  targetBranch: 'develop',
  conversationId: 'conversation-1',
  sharedConversation: false,
  resolutionMode: 'full',
  chatMessages: [],
  chatMessagesLoaded: false,
  chatTranscriptRevision: 'revision-1',
  chatMessageCount: 2,
  replicaScopeKey: 'project:one',
  replicaProjectId: 'one',
  ...overrides,
});

describe('Architect conversation transcript parameters', () => {
  it('keeps the unloaded transcript bound to the selected head identity', () => {
    expect(buildArchitectPlanConversationTranscriptParams(payload())).toEqual({
      conversationIdHint: 'conversation-1',
      chatMessagesHint: [],
      chatMessagesLoaded: false,
      chatTranscriptRevision: 'revision-1',
      chatMessageCount: 2,
      replicaScopeKey: 'project:one',
      replicaProjectId: 'one',
    });
  });

  it('rejects an unloaded transcript without its replica scope', () => {
    expect(() => buildArchitectPlanConversationTranscriptParams(payload({ replicaScopeKey: null })))
      .toThrow('transcript replica identity is incomplete');
  });

  it('keeps a blank head self-contained without requesting a replica', () => {
    const params = buildArchitectPlanConversationTranscriptParams(payload({
      resolutionMode: 'blank_fast_path', chatMessagesLoaded: true,
      chatMessageCount: 0, replicaScopeKey: null, replicaProjectId: null,
      chatTranscriptRevision: null,
    }));
    expect(params.chatMessagesLoaded).toBe(true);
    expect(params.chatMessageCount).toBe(0);
    expect(params.replicaScopeKey).toBeNull();
  });

  it('preserves a legacy loaded transcript instead of treating it as an empty head', () => {
    const messages = [{ id: 'message-1', role: 'user' as const, content: 'Saved request', createdAt: '2026-04-28T00:00:00.000Z' }];
    const params = buildArchitectPlanConversationTranscriptParams(payload({
      chatMessages: messages, chatMessagesLoaded: undefined, chatMessageCount: undefined,
      replicaScopeKey: null, replicaProjectId: null, chatTranscriptRevision: null,
    }));
    expect(params.chatMessagesHint).toEqual(messages);
    expect(params.chatMessagesLoaded).toBe(true);
    expect(params.chatMessageCount).toBe(1);
  });
});
