import { expect, it, mock } from 'bun:test';
import { act, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { useConversationArchiveStore } from '../../../stores/useConversationArchiveStore';
import type { MockChatState, MockMessage } from '../ChatZone.test';

export type QuestionnaireApprovalScenarioContext = {
  chatState: MockChatState;
  renderChatZone: () => ReactElement;
  buildMessage: (overrides: Partial<MockMessage>) => MockMessage;
  requireContainer: () => HTMLDivElement;
  requireRoot: () => Root;
  emitChatStore: () => void;
  setChatStoreState: (state: Partial<MockChatState>) => void;
};

export const registerQuestionnaireApprovalScenarios = (
  context: QuestionnaireApprovalScenarioContext,
) => {
  const { buildMessage, renderChatZone, requireContainer, requireRoot } = context;

  it('renders the active questionnaire in the footer and hides the standard composer', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need one blocking decision.',
          questionnaire: {
            intro: 'Need one blocking decision.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('Which scope should I use?');
    const footer = requireContainer().querySelector('[data-testid="questionnaire-footer"]');
    const choiceList = requireContainer().querySelector('[data-testid="questionnaire-choice-list"]');
    const stepPanel = requireContainer().querySelector('[data-testid="questionnaire-step-panel"]');
    expect(footer?.textContent).toContain('Question');
    expect(footer?.textContent).not.toContain('Need one blocking decision.');
    expect(choiceList?.className).toContain('flex-col');
    expect(stepPanel?.className).toContain('questionnaire-step-enter');
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).toBeNull();
  });

  it('renders the active tool approval footer and hides the standard composer', async () => {
    context.chatState = {
      ...context.chatState,
      pendingToolApprovalByConversationId: {
        'conv-1': {
          conversationId: 'conv-1',
          assistantMessageId: 'msg-assistant-1',
          toolCallId: 'tool-call-1',
          toolId: 'terminal_run',
          actionGroup: 'escape',
          riskLevel: 'balanced',
          isDestructive: true,
          summary: 'Run a terminal command',
          detail: 'npm test',
          rememberKey: 'terminal:npm test',
        },
      },
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const footer = requireContainer().querySelector('[data-testid="tool-approval-footer"]');
    expect(footer?.textContent).toContain('Tool approval');
    expect(footer?.textContent).toContain('Run a terminal command');
    expect(footer?.textContent).toContain('System');
    expect(footer?.textContent).not.toContain('terminal_run');
    expect(footer?.textContent).toContain('Allow once');
    expect(footer?.textContent).toContain('Allow for this conversation');
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).toBeNull();
  });

  it('offers a new turn and dismissal for an interrupted approval', async () => {
    context.chatState = {
      ...context.chatState,
      pendingToolApprovalByConversationId: { 'conv-1': {
        conversationId: 'conv-1', assistantMessageId: 'msg-assistant-1', toolCallId: 'old-call',
        toolId: 'terminal_run', actionGroup: 'escape', riskLevel: 'strict', summary: 'terminal_run',
        rememberKey: '', recoveryState: 'interrupted',
      } },
    };
    await act(async () => { requireRoot().render(renderChatZone()); });
    const footer = requireContainer().querySelector('[data-testid="tool-approval-footer"]');
    expect(footer?.textContent).toContain('interrupted');
    expect(footer?.textContent).not.toContain('Allow once');
    expect(footer?.textContent).not.toContain('Allow for this conversation');
    const buttons = Array.from(footer?.querySelectorAll('button') ?? []);
    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Resume with a new turn'))?.click();
      buttons.find((button) => button.textContent?.includes('Dismiss'))?.click();
    });
    expect(context.chatState.approvePendingToolApprovalOnce).toHaveBeenCalledWith('conv-1');
    expect(context.chatState.denyPendingToolApproval).toHaveBeenCalledWith('conv-1', undefined);
    expect(requireContainer().querySelector('[data-testid="tool-approval-deny-reason"]')).toBeNull();
  });

  it('hides interrupted approval actions in an archived conversation', async () => {
    context.chatState = {
      ...context.chatState,
      pendingToolApprovalByConversationId: { 'conv-1': {
        conversationId: 'conv-1', assistantMessageId: 'msg-assistant-1', toolCallId: 'old-call',
        toolId: 'terminal_run', actionGroup: 'escape', riskLevel: 'strict', summary: 'terminal_run',
        rememberKey: '', recoveryState: 'interrupted',
      } },
    };
    useConversationArchiveStore.getState().replaceArchivedConversationIds(['conv-1']);
    await act(async () => { requireRoot().render(renderChatZone()); });
    expect(requireContainer().querySelector('[data-testid="tool-approval-footer"]')).toBeNull();
    expect(context.chatState.approvePendingToolApprovalOnce).not.toHaveBeenCalled();
  });

  it('explains preserved recovery data and lets the user close the warning', async () => {
    context.chatState = { ...context.chatState, toolApprovalRecoveryError: 'Saved tool approvals could not be restored: invalid recovery data.' };
    await act(async () => { requireRoot().render(renderChatZone()); });
    expect(requireContainer().textContent).toContain('Their data has been kept');
    expect(requireContainer().textContent).not.toContain('Review the details, then try again');
    const close = Array.from(requireContainer().querySelectorAll('button')).find((button) => button.textContent === 'Close');
    expect(close).toBeDefined();
    await act(async () => { close?.click(); });
    expect(context.chatState.dismissToolApprovalRecoveryError).toHaveBeenCalledTimes(1);
    expect(context.chatState.clearLastError).not.toHaveBeenCalled();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).not.toBeNull();
  });

  it('forwards tool approval actions to the chat store', async () => {
    context.chatState = {
      ...context.chatState,
      pendingToolApprovalByConversationId: {
        'conv-1': {
          conversationId: 'conv-1',
          assistantMessageId: 'msg-assistant-1',
          toolCallId: 'tool-call-1',
          toolId: 'web_fetch',
          actionGroup: 'escape',
          riskLevel: 'balanced',
          isDestructive: false,
          summary: 'Fetch a web page',
          detail: 'example.com',
          rememberKey: 'domain:example.com',
        },
      },
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const allowOnceButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Allow once')
    );
    const allowConversationButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Allow for this conversation')
    );
    const denyButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Refuse')
    );

    await act(async () => {
      allowOnceButton?.click();
      allowConversationButton?.click();
      denyButton?.click();
    });

    expect(context.chatState.approvePendingToolApprovalOnce).toHaveBeenCalledWith('conv-1');
    expect(context.chatState.approvePendingToolApprovalForConversation).toHaveBeenCalledWith('conv-1');
    expect(context.chatState.denyPendingToolApproval).not.toHaveBeenCalled();
  });

  it('forwards tool denial confirmations to the chat store', async () => {
    context.chatState = {
      ...context.chatState,
      pendingToolApprovalByConversationId: {
        'conv-1': {
          conversationId: 'conv-1',
          assistantMessageId: 'msg-assistant-1',
          toolCallId: 'tool-call-1',
          toolId: 'web_fetch',
          actionGroup: 'escape',
          riskLevel: 'balanced',
          isDestructive: false,
          summary: 'Fetch a web page',
          detail: 'example.com',
          rememberKey: 'domain:example.com',
        },
      },
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const denyButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Refuse')
    );

    await act(async () => {
      denyButton?.click();
    });

    const confirmDenyButton = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Confirm denial')
    );

    await act(async () => {
      confirmDenyButton?.click();
    });

    expect(context.chatState.denyPendingToolApproval).toHaveBeenCalledWith('conv-1', undefined);
  });

  it('submits the questionnaire when the user clicks a suggested answer', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need one blocking decision.',
          questionnaire: {
            intro: 'Need one blocking decision.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        }),
      ],
      recordActiveQuestionnaireAnswer: mock(() => ({ completed: true, state: null })),
      submitActiveQuestionnaire: mock(async () => ({ status: 'sent' })),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const button = Array.from(requireContainer().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Balanced')
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
    });

    expect(context.chatState.recordActiveQuestionnaireAnswer).toHaveBeenCalledWith('conv-1', 'Balanced');
    expect(context.chatState.submitActiveQuestionnaire).toHaveBeenCalledWith('conv-1');
  });

  it('renders the inline free-text questionnaire input in the footer', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need one blocking decision.',
          questionnaire: {
            intro: 'Need one blocking decision.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
                free_text_placeholder: 'Custom answer',
              },
            ],
          },
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const input = requireContainer().querySelector('input');
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).getAttribute('placeholder')).toBe('Custom answer');
  });

  it('updates the question and choices when advancing to the next questionnaire step', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need two decisions.',
          questionnaire: {
            intro: 'Need two decisions.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
            ],
          },
        }),
      ],
      recordActiveQuestionnaireAnswer: mock((_conversationId: string, answer: string) => {
        context.chatState = {
          ...context.chatState,
          questionnaireDraftsByConversationId: {
            ...context.chatState.questionnaireDraftsByConversationId,
            'conv-1': {
              assistantMessageId: 'msg-assistant-1',
              currentStepIndex: 1,
              answersByStepId: {
                scope: answer,
              },
              draftTextByStepId: {},
            },
          },
        };
        context.emitChatStore();
        return {
          completed: false,
          state: null,
        };
      }),
      submitActiveQuestionnaire: mock(async () => ({ status: 'sent' })),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('Which scope should I use?');
    expect(requireContainer().textContent).toContain('Balanced');

    const firstStepButton = Array.from(
      requireContainer().querySelectorAll('button')
    ).find((candidate) => candidate.textContent?.includes('Balanced'));
    expect(firstStepButton).toBeDefined();

    await act(async () => {
      firstStepButton?.click();
    });

    expect(requireContainer().textContent).toContain('How risky can the change be?');
    expect(requireContainer().textContent).toContain('Aggressive');
    expect(requireContainer().textContent).not.toContain('Which scope should I use?');
    expect(requireContainer().textContent).not.toContain('Balanced');
    expect(context.chatState.submitActiveQuestionnaire).not.toHaveBeenCalled();
    expect(
      requireContainer()
        .querySelector('[data-testid="questionnaire-step-panel"]')
        ?.className
    ).toContain('questionnaire-step-enter');
  });

  it('returns to the first unanswered question before submitting a skipped questionnaire step', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need three decisions.',
          questionnaire: {
            intro: 'Need three decisions.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
              {
                id: 'timing',
                prompt: 'How soon do you need it?',
                choices: ['Today', 'This week', 'Later'],
              },
            ],
          },
        }),
      ],
      questionnaireDraftsByConversationId: {
        'conv-1': {
          assistantMessageId: 'msg-assistant-1',
          currentStepIndex: 2,
          answersByStepId: {
            scope: 'Balanced',
          },
          draftTextByStepId: {},
        },
      },
      recordActiveQuestionnaireAnswer: mock((_conversationId: string, answer: string) => {
        context.chatState = {
          ...context.chatState,
          questionnaireDraftsByConversationId: {
            ...context.chatState.questionnaireDraftsByConversationId,
            'conv-1': {
              assistantMessageId: 'msg-assistant-1',
              currentStepIndex: 1,
              answersByStepId: {
                scope: 'Balanced',
                timing: answer,
              },
              draftTextByStepId: {},
            },
          },
        };
        context.emitChatStore();
        return {
          completed: false,
          state: null,
        };
      }),
      submitActiveQuestionnaire: mock(async () => ({ status: 'sent' })),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('How soon do you need it?');

    const lastStepButton = Array.from(
      requireContainer().querySelectorAll('button')
    ).find((candidate) => candidate.textContent?.includes('This week'));
    expect(lastStepButton).toBeDefined();

    await act(async () => {
      lastStepButton?.click();
    });

    expect(context.chatState.recordActiveQuestionnaireAnswer).toHaveBeenCalledWith('conv-1', 'This week');
    expect(context.chatState.submitActiveQuestionnaire).not.toHaveBeenCalled();
    expect(requireContainer().textContent).toContain('How risky can the change be?');
    expect(requireContainer().textContent).not.toContain('How soon do you need it?');
  });

  it('lets the user navigate forward and backward between questionnaire steps', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need two decisions.',
          questionnaire: {
            intro: 'Need two decisions.',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
            ],
          },
        }),
      ],
      setActiveQuestionnaireStep: mock((_conversationId: string, stepIndex: number) => {
        context.chatState = {
          ...context.chatState,
          questionnaireDraftsByConversationId: {
            ...context.chatState.questionnaireDraftsByConversationId,
            'conv-1': {
              assistantMessageId: 'msg-assistant-1',
              currentStepIndex: stepIndex,
              answersByStepId: {},
              draftTextByStepId: {},
            },
          },
        };
        context.emitChatStore();
      }),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().textContent).toContain('Which scope should I use?');

    const nextButton = requireContainer().querySelector(
      '[data-testid="questionnaire-step-nav-next"]'
    ) as HTMLButtonElement | null;
    expect(nextButton).not.toBeNull();

    await act(async () => {
      nextButton?.click();
    });

    expect(context.chatState.setActiveQuestionnaireStep).toHaveBeenCalledWith('conv-1', 1);
    expect(requireContainer().textContent).toContain('How risky can the change be?');
    expect(requireContainer().textContent).toContain('Aggressive');
    expect(requireContainer().textContent).not.toContain('Which scope should I use?');

    const previousButton = requireContainer().querySelector(
      '[data-testid="questionnaire-step-nav-prev"]'
    ) as HTMLButtonElement | null;
    expect(previousButton).not.toBeNull();

    await act(async () => {
      previousButton?.click();
    });

    expect(context.chatState.setActiveQuestionnaireStep).toHaveBeenCalledWith('conv-1', 0);
    expect(requireContainer().textContent).toContain('Which scope should I use?');
    expect(requireContainer().textContent).toContain('Balanced');
    expect(requireContainer().textContent).not.toContain('How risky can the change be?');
    expect(context.chatState.submitActiveQuestionnaire).not.toHaveBeenCalled();
  });

  it('renders compact step arrows around the questionnaire progress', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Need two decisions.',
          questionnaire: {
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
              },
            ],
          },
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const footer = requireContainer().querySelector('[data-testid="questionnaire-footer"]');
    const previousButton = requireContainer().querySelector('[data-testid="questionnaire-step-nav-prev"]');
    const nextButton = requireContainer().querySelector('[data-testid="questionnaire-step-nav-next"]');
    const counterShell = requireContainer().querySelector('[data-testid="questionnaire-step-counter-shell"]');
    const counter = requireContainer().querySelector('[data-testid="questionnaire-step-counter"]');

    expect(footer?.textContent).toContain('Question');
    expect(counter?.textContent).toBe('1/2');
    expect(counterShell).not.toBeNull();
    expect(previousButton).not.toBeNull();
    expect(nextButton).not.toBeNull();
    expect(footer?.textContent).not.toContain('Voir la suite');
    expect(footer?.textContent).not.toContain('Retour');
  });

  it('renders questionnaire response summaries with the dedicated user bubble layout', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content:
            'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
          questionnaire_response_summary: {
            assistantMessageId: 'msg-assistant-1',
            source: 'tool',
            originToolCallId: 'call_question',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                answer: 'Stay below one day of rework',
              },
            ],
          },
        }),
      ],
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    expect(requireContainer().querySelector('[data-testid="questionnaire-response-summary"]')).not.toBeNull();
    expect(requireContainer().textContent).toContain('Réponses au questionnaire');
    expect(requireContainer().textContent).toContain('Which scope should I use?');
    expect(requireContainer().textContent).toContain('Stay below one day of rework');
  });

  it('reopens questionnaire responses in the footer instead of inline editing', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'assistant-questionnaire',
          role: 'assistant',
          content: 'Need two clarifications.',
          questionnaire: {
            intro: 'Need two clarifications.',
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                choices: ['Safe', 'Moderate', 'Aggressive'],
                free_text_placeholder: 'Custom answer',
              },
            ],
          },
        }),
        buildMessage({
          id: 'user-questionnaire',
          role: 'user',
          content:
            'Which scope should I use?: Balanced\nHow risky can the change be?: Stay below one day of rework',
          questionnaire_response_summary: {
            assistantMessageId: 'assistant-questionnaire',
            source: 'tool',
            originToolCallId: 'call_question',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
              {
                id: 'risk',
                prompt: 'How risky can the change be?',
                answer: 'Stay below one day of rework',
              },
            ],
          },
        }),
      ],
      startQuestionnaireResponseEdit: mock((messageId: string) => {
        context.setChatStoreState({
          questionnaireDraftsByConversationId: {
            'conv-1': {
              mode: 'editing_response',
              assistantMessageId: 'assistant-questionnaire',
              responseMessageId: messageId,
              currentStepIndex: 0,
              answersByStepId: {
                scope: 'Balanced',
                risk: 'Stay below one day of rework',
              },
              draftTextByStepId: {
                risk: 'Stay below one day of rework',
              },
            },
          },
        });
        return true;
      }),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const editButton = requireContainer().querySelector('button[title="common.edit"]');
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(context.chatState.startQuestionnaireResponseEdit).toHaveBeenCalledWith('user-questionnaire');
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).not.toBeNull();
    expect(requireContainer().querySelector('textarea')).toBeNull();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).toBeNull();

    const balancedButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Balanced'
    );
    expect(balancedButton?.className).toContain('border-primary/50');
  });

  it('reopens questionnaire responses from conversation-indexed messages after reload', async () => {
    const conversationMessages = [
      buildMessage({
        id: 'assistant-questionnaire',
        role: 'assistant',
        content: 'Need one clarification.',
        questionnaire: {
          source: 'tool',
          questions: [
            {
              id: 'scope',
              prompt: 'Which scope should I use?',
              choices: ['Minimal', 'Balanced', 'Large'],
            },
          ],
        },
      }),
      buildMessage({
        id: 'user-questionnaire',
        role: 'user',
        content: 'Which scope should I use?: Balanced',
        questionnaire_response_summary: {
          assistantMessageId: 'assistant-questionnaire',
          source: 'tool',
          originToolCallId: 'call_question',
          items: [
            {
              id: 'scope',
              prompt: 'Which scope should I use?',
              answer: 'Balanced',
            },
          ],
        },
      }),
    ];
    context.chatState = {
      ...context.chatState,
      messages: [],
      messagesByConversationId: {
        'conv-1': conversationMessages,
      },
      startQuestionnaireResponseEdit: mock((messageId: string) => {
        context.chatState = {
          ...context.chatState,
          questionnaireDraftsByConversationId: {
            'conv-1': {
              mode: 'editing_response',
              assistantMessageId: 'assistant-questionnaire',
              responseMessageId: messageId,
              currentStepIndex: 0,
              answersByStepId: {
                scope: 'Balanced',
              },
              draftTextByStepId: {},
            },
          },
        };
        context.emitChatStore();
        return true;
      }),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const editButton = requireContainer().querySelector('button[title="common.edit"]');
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(context.chatState.startQuestionnaireResponseEdit).toHaveBeenCalledWith('user-questionnaire');
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).not.toBeNull();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).toBeNull();
    expect(requireContainer().querySelectorAll('textarea')).toHaveLength(0);
  });

  it('does not fall back to raw text editing when questionnaire response edit cannot reopen', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'user-questionnaire',
          role: 'user',
          content: 'Which scope should I use?: Balanced',
          questionnaire_response_summary: {
            assistantMessageId: 'missing-assistant-questionnaire',
            source: 'tool',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
            ],
          },
        }),
      ],
      startQuestionnaireResponseEdit: mock(() => false),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const editButton = requireContainer().querySelector('button[title="common.edit"]');
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(context.chatState.startQuestionnaireResponseEdit).toHaveBeenCalledWith('user-questionnaire');
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).toBeNull();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).not.toBeNull();
    expect(requireContainer().querySelectorAll('textarea')).toHaveLength(1);
  });

  it('cancels questionnaire response editing without touching the message history', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'assistant-questionnaire',
          role: 'assistant',
          content: 'Need one clarification.',
          questionnaire: {
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        }),
        buildMessage({
          id: 'user-questionnaire',
          role: 'user',
          content: 'Which scope should I use?: Balanced',
          questionnaire_response_summary: {
            assistantMessageId: 'assistant-questionnaire',
            source: 'tool',
            originToolCallId: 'call_question',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
            ],
          },
        }),
      ],
      questionnaireDraftsByConversationId: {
        'conv-1': {
          mode: 'editing_response',
          assistantMessageId: 'assistant-questionnaire',
          responseMessageId: 'user-questionnaire',
          currentStepIndex: 0,
          answersByStepId: {
            scope: 'Balanced',
          },
          draftTextByStepId: {},
        },
      },
      cancelQuestionnaireSession: mock((conversationId: string) => {
        const nextDrafts = { ...context.chatState.questionnaireDraftsByConversationId };
        delete nextDrafts[conversationId];
        context.chatState = {
          ...context.chatState,
          questionnaireDraftsByConversationId: nextDrafts,
        };
        context.emitChatStore();
      }),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const cancelButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Annuler'
    );
    expect(cancelButton).not.toBeNull();

    await act(async () => {
      cancelButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(context.chatState.cancelQuestionnaireSession).toHaveBeenCalledWith('conv-1');
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).toBeNull();
    expect(requireContainer().querySelector('[data-testid="composer-editor"]')).not.toBeNull();
    expect(context.chatState.editMessage).not.toHaveBeenCalled();
    expect(context.chatState.submitActiveQuestionnaire).not.toHaveBeenCalled();
  });

  it('keeps only questionnaire cancel enabled while editing during streaming', async () => {
    context.chatState = {
      ...context.chatState,
      messages: [
        buildMessage({
          id: 'assistant-questionnaire',
          role: 'assistant',
          content: 'Need one clarification.',
          questionnaire: {
            source: 'tool',
            questions: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                choices: ['Minimal', 'Balanced', 'Large'],
              },
            ],
          },
        }),
        buildMessage({
          id: 'user-questionnaire',
          role: 'user',
          content: 'Which scope should I use?: Balanced',
          questionnaire_response_summary: {
            assistantMessageId: 'assistant-questionnaire',
            source: 'tool',
            items: [
              {
                id: 'scope',
                prompt: 'Which scope should I use?',
                answer: 'Balanced',
              },
            ],
          },
        }),
      ],
      questionnaireDraftsByConversationId: {
        'conv-1': {
          mode: 'editing_response',
          assistantMessageId: 'assistant-questionnaire',
          responseMessageId: 'user-questionnaire',
          currentStepIndex: 0,
          answersByStepId: {
            scope: 'Balanced',
          },
          draftTextByStepId: {},
        },
      },
      isStreaming: true,
      sendState: 'streaming',
      cancelQuestionnaireSession: mock((conversationId: string) => {
        const nextDrafts = { ...context.chatState.questionnaireDraftsByConversationId };
        delete nextDrafts[conversationId];
        context.chatState = {
          ...context.chatState,
          questionnaireDraftsByConversationId: nextDrafts,
        };
        context.emitChatStore();
      }),
    };

    await act(async () => {
      requireRoot().render(renderChatZone());
    });

    const cancelButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Annuler'
    ) as HTMLButtonElement | undefined;
    const submitButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Envoyer'
    ) as HTMLButtonElement | undefined;
    const choiceButton = Array.from(requireContainer().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Balanced'
    ) as HTMLButtonElement | undefined;
    const textInput = requireContainer().querySelector('input[type="text"]') as HTMLInputElement | null;

    expect(cancelButton).not.toBeNull();
    expect(cancelButton?.disabled).toBe(false);
    expect(submitButton?.disabled).toBe(true);
    expect(choiceButton?.disabled).toBe(true);
    expect(textInput?.disabled).toBe(true);

    await act(async () => {
      cancelButton?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(context.chatState.cancelQuestionnaireSession).toHaveBeenCalledWith('conv-1');
    expect(context.chatState.stopStreaming).not.toHaveBeenCalled();
    expect(requireContainer().querySelector('[data-testid="questionnaire-footer"]')).toBeNull();
  });};
