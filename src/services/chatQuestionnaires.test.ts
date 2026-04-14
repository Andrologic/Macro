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
