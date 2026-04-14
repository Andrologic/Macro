import { describe, expect, it } from "bun:test";
import type { ChatMessage, ConversationQuestionnaireDraft } from "../types";
import {
  buildQuestionnaireAggregatedResponse,
  buildQuestionnaireFunctionCallOutputItem,
  buildQuestionnaireHiddenContextBlock,
  buildQuestionnaireResponseHiddenContextBlock,
  buildQuestionnaireResponseSummary,
  buildQuestionnaireResponseVisibleContent,
  extractQuestionToolCallIdFromProviderInputItems,
  parseAssistantQuestionnaireState,
  parseQuestionnairePayloadFromHiddenContext,
  parseQuestionnaireResponseSummaryFromHiddenContext,
  resolveActiveConversationQuestionnaire,
  validateQuestionToolArgs,
} from "./chatQuestionnaires";

describe("chatQuestionnaires", () => {
  it("validates a multi-step questionnaire tool payload and round-trips hidden context", () => {
    const payload = validateQuestionToolArgs({
      intro: "Need two choices before I continue.",
      questions: [
        {
          id: "scope",
          prompt: "Which scope should I use?",
          choices: ["Minimal", "Balanced", "Large"],
        },
        {
          id: "risk",
          prompt: "How risky can the change be?",
          choices: ["Safe", "Moderate", "Aggressive"],
          free_text_placeholder: "Custom risk tolerance",
        },
      ],
    });

    const parsed = parseQuestionnairePayloadFromHiddenContext(
      buildQuestionnaireHiddenContextBlock(payload),
    );

    expect(parsed).toEqual(payload);
  });

  it("rejects question tool payloads that do not provide exactly three choices", () => {
    expect(() =>
      validateQuestionToolArgs({
        questions: [
          {
            id: "scope",
            prompt: "Which scope should I use?",
            choices: ["Only one option"],
          },
        ],
      }),
    ).toThrow("exactly 3 suggested choices");
  });

  it("normalizes legacy quick replies into a single-step questionnaire", () => {
    const parsed = parseAssistantQuestionnaireState(
      [
        "Need one blocking decision.",
        "",
        "[quick-replies]",
        "- Keep the current UX",
        "- Add the questionnaire footer",
        "- Hide the feature for now",
        "[/quick-replies]",
      ].join("\n"),
    );

    expect(parsed.requiresUserReply).toBe(true);
    expect(parsed.content).toBe("Need one blocking decision.");
    expect(parsed.questionnaire?.source).toBe("legacy_quick_replies");
    expect(parsed.questionnaire?.questions[0]?.prompt).toBe(
      "Need one blocking decision.",
    );
  });

  it("resolves the latest unresolved questionnaire with persisted partial answers", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        task_id: "task-1",
        conversation_id: "conv-1",
        role: "assistant",
        content: "Need two clarifications.",
        timestamp: "2026-04-14T10:00:00.000Z",
        provider_input_items: [
          {
            type: "function_call",
            call_id: "call_question",
            name: "question",
            arguments:
              '{"intro":"Need two clarifications.","questions":[{"id":"scope","prompt":"Which scope should I use?","choices":["Minimal","Balanced","Large"]},{"id":"risk","prompt":"How risky can the change be?","choices":["Safe","Moderate","Aggressive"]}]}',
          },
        ],
        questionnaire: validateQuestionToolArgs({
          intro: "Need two clarifications.",
          questions: [
            {
              id: "scope",
              prompt: "Which scope should I use?",
              choices: ["Minimal", "Balanced", "Large"],
            },
            {
              id: "risk",
              prompt: "How risky can the change be?",
              choices: ["Safe", "Moderate", "Aggressive"],
            },
          ],
        }),
      },
    ];
    const draft: ConversationQuestionnaireDraft = {
      assistantMessageId: "assistant-1",
      currentStepIndex: 1,
      answersByStepId: {
        scope: "Balanced",
      },
      draftTextByStepId: {
        risk: "Stay under one day of rework",
      },
    };

    const state = resolveActiveConversationQuestionnaire(
      "conv-1",
      messages,
      draft,
    );

    expect(state).not.toBeNull();
    expect(state?.currentStep.id).toBe("risk");
    expect(state?.originToolCallId).toBe("call_question");
    expect(state?.answersByStepId.scope).toBe("Balanced");
    expect(state?.draftTextByStepId.risk).toBe(
      "Stay under one day of rework",
    );
    expect(
      buildQuestionnaireAggregatedResponse(
        state!.questionnaire,
        {
          ...state!.answersByStepId,
          risk: "Stay under one day of rework",
        },
      ),
    ).toContain("How risky can the change be?: Stay under one day of rework");
  });

  it("reconstructs an editing session from a questionnaire response summary", () => {
    const questionnaire = validateQuestionToolArgs({
      intro: "Need two clarifications.",
      questions: [
        {
          id: "scope",
          prompt: "Which scope should I use?",
          choices: ["Minimal", "Balanced", "Large"],
        },
        {
          id: "risk",
          prompt: "How risky can the change be?",
          choices: ["Safe", "Moderate", "Aggressive"],
          free_text_placeholder: "Custom answer",
        },
      ],
    });
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        task_id: "task-1",
        conversation_id: "conv-1",
        role: "assistant",
        content: "Need two clarifications.",
        timestamp: "2026-04-14T10:00:00.000Z",
        provider_input_items: [
          {
            type: "function_call",
            call_id: "call_question",
            name: "question",
            arguments:
              '{"intro":"Need two clarifications.","questions":[{"id":"scope","prompt":"Which scope should I use?","choices":["Minimal","Balanced","Large"]},{"id":"risk","prompt":"How risky can the change be?","choices":["Safe","Moderate","Aggressive"],"free_text_placeholder":"Custom answer"}]}',
          },
        ],
        questionnaire,
      },
      {
        id: "user-1",
        task_id: "task-1",
        conversation_id: "conv-1",
        role: "user",
        content:
          "Which scope should I use?: Balanced\nHow risky can the change be?: Stay under one day of rework",
        timestamp: "2026-04-14T10:01:00.000Z",
        questionnaire_response_summary: {
          assistantMessageId: "assistant-1",
          source: "tool",
          originToolCallId: "call_question",
          items: [
            {
              id: "scope",
              prompt: "Which scope should I use?",
              answer: "Balanced",
            },
            {
              id: "risk",
              prompt: "How risky can the change be?",
              answer: "Stay under one day of rework",
            },
          ],
        },
      },
      {
        id: "assistant-2",
        task_id: "task-1",
        conversation_id: "conv-1",
        role: "assistant",
        content: "Thanks, I can continue.",
        timestamp: "2026-04-14T10:02:00.000Z",
      },
    ];

    const state = resolveActiveConversationQuestionnaire("conv-1", messages, {
      mode: "editing_response",
      assistantMessageId: "assistant-1",
      responseMessageId: "user-1",
      currentStepIndex: 0,
      answersByStepId: {
        scope: "Balanced",
        risk: "Stay under one day of rework",
      },
      draftTextByStepId: {},
    });

    expect(state?.mode).toBe("editing_response");
    expect(state?.responseMessageId).toBe("user-1");
    expect(state?.currentStep.id).toBe("scope");
    expect(state?.answersByStepId).toEqual({
      scope: "Balanced",
      risk: "Stay under one day of rework",
    });
    expect(state?.draftTextByStepId).toEqual({
      risk: "Stay under one day of rework",
    });
  });

  it("builds a questionnaire response summary payload and tool output item", () => {
    const questionnaire = validateQuestionToolArgs({
      intro: "Need two clarifications.",
      questions: [
        {
          id: "scope",
          prompt: "Which scope should I use?",
          choices: ["Minimal", "Balanced", "Large"],
        },
      ],
    });
    const summary = buildQuestionnaireResponseSummary(
      "assistant-1",
      questionnaire,
      { scope: "Balanced" },
      { originToolCallId: "call_question" },
    );

    expect(
      parseQuestionnaireResponseSummaryFromHiddenContext(
        buildQuestionnaireResponseHiddenContextBlock(summary),
      ),
    ).toEqual(summary);
    expect(buildQuestionnaireResponseVisibleContent(summary)).toBe(
      "Which scope should I use?: Balanced",
    );
    expect(buildQuestionnaireFunctionCallOutputItem(summary)).toEqual({
      type: "function_call_output",
      call_id: "call_question",
      output: "Questionnaire responses:\n- Which scope should I use?: Balanced",
    });
  });

  it("extracts the originating question tool call id from provider transcript items", () => {
    expect(
      extractQuestionToolCallIdFromProviderInputItems([
        {
          type: "output_text",
          text: "Need one choice.",
        },
        {
          type: "function_call",
          call_id: "call_question",
          name: "question",
          arguments:
            '{"intro":"Need one choice.","questions":[{"id":"scope","prompt":"Which scope should I use?","choices":["Minimal","Balanced","Large"]}]}',
        },
      ]),
    ).toBe("call_question");
  });
});
