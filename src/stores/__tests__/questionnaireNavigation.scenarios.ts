import { describe, expect, it } from 'bun:test';
import type { ChatMessage, Conversation } from '../../types';
import type { useChatStore as UseChatStore } from '../useChatStore';

interface QuestionnaireNavigationScenarioContext {
  createConversation: (id: string, projectId?: string) => Conversation;
  loadChatStore: () => Promise<{ useChatStore: typeof UseChatStore }>;
  setChatMode: () => void;
}

const createQuestionnaireMessage = (questionCount: 2 | 3): ChatMessage => ({
  id: 'assistant-questionnaire',
  task_id: '',
  conversation_id: 'chat-conv',
  role: 'assistant' as const,
  content: `Need ${questionCount === 2 ? 'two' : 'three'} clarifications.`,
  timestamp: '2026-04-14T10:00:00.000Z',
  questionnaire: {
    intro: `Need ${questionCount === 2 ? 'two' : 'three'} clarifications.`,
    source: 'tool' as const,
    questions: [
      {
        id: 'scope',
        prompt: 'Which scope should I use?',
        choices: ['Minimal', 'Balanced', 'Large'],
        free_text_placeholder: questionCount === 2 ? 'Custom scope' : undefined,
      },
      {
        id: 'risk',
        prompt: 'How risky can the change be?',
        choices: ['Safe', 'Moderate', 'Aggressive'],
        free_text_placeholder: questionCount === 2 ? 'Custom risk' : undefined,
      },
      ...(questionCount === 3
        ? [{
            id: 'timing',
            prompt: 'How soon do you need it?',
            choices: ['Today', 'This week', 'Later'] as [string, string, string],
          }]
        : []),
    ],
  },
});

export const registerQuestionnaireNavigationScenarios = (
  context: QuestionnaireNavigationScenarioContext,
) => {
  const loadQuestionnaire = async (
    questionCount: 2 | 3,
    draft: {
      currentStepIndex: number;
      answersByStepId: Record<string, string>;
      draftTextByStepId: Record<string, string>;
    },
  ) => {
    context.setChatMode();
    const { useChatStore } = await context.loadChatStore();
    useChatStore.setState({
      conversations: [context.createConversation('chat-conv', '')],
      messages: [createQuestionnaireMessage(questionCount)],
      selectedConversationId: 'chat-conv',
      selectedConversationIdsByMode: { Chat: 'chat-conv' },
      isLoading: false,
      isStreaming: false,
      sendState: 'idle',
      lastError: null,
      abortController: null,
      messageImagesByMessageId: {},
      questionnaireDraftsByConversationId: {
        'chat-conv': {
          assistantMessageId: 'assistant-questionnaire',
          ...draft,
        },
      },
      composerContextRefs: [],
    });
    return useChatStore;
  };

  describe('useChatStore questionnaire navigation', () => {
    it('navigates between questionnaire steps while preserving existing answers and drafts', async () => {
      const useChatStore = await loadQuestionnaire(2, {
        currentStepIndex: 0,
        answersByStepId: { scope: 'Balanced' },
        draftTextByStepId: { risk: 'Stay below one day of rework' },
      });

      useChatStore.getState().setActiveQuestionnaireStep('chat-conv', 1);
      expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
        currentStepIndex: 1,
        currentStep: { id: 'risk' },
        answersByStepId: { scope: 'Balanced' },
        draftTextByStepId: { risk: 'Stay below one day of rework' },
      });

      useChatStore.getState().setActiveQuestionnaireStep('chat-conv', 0);
      expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
        currentStepIndex: 0,
        currentStep: { id: 'scope' },
        answersByStepId: { scope: 'Balanced' },
        draftTextByStepId: { risk: 'Stay below one day of rework' },
      });
    });

    it('returns to the first unanswered questionnaire step before finishing', async () => {
      const useChatStore = await loadQuestionnaire(3, {
        currentStepIndex: 2,
        answersByStepId: { scope: 'Balanced' },
        draftTextByStepId: {},
      });

      const result = useChatStore
        .getState()
        .recordActiveQuestionnaireAnswer('chat-conv', 'This week');

      expect(result?.completed).toBe(false);
      expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
        currentStepIndex: 1,
        currentStep: { id: 'risk' },
        answersByStepId: { scope: 'Balanced', timing: 'This week' },
      });
    });

    it('repositions direct questionnaire submission to the first unanswered step', async () => {
      const useChatStore = await loadQuestionnaire(3, {
        currentStepIndex: 2,
        answersByStepId: { scope: 'Balanced', timing: 'This week' },
        draftTextByStepId: {},
      });

      const result = await useChatStore.getState().submitActiveQuestionnaire('chat-conv');

      expect(result).toBeNull();
      expect(useChatStore.getState().getActiveQuestionnaire('chat-conv')).toMatchObject({
        currentStepIndex: 1,
        currentStep: { id: 'risk' },
        answersByStepId: { scope: 'Balanced', timing: 'This week' },
      });
      expect(
        useChatStore
          .getState()
          .getConversationMessages('chat-conv')
          .filter((message) => message.role === 'user'),
      ).toHaveLength(0);
    });
  });
};
