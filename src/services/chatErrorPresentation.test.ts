import { describe, expect, it } from "bun:test";
import {
  buildProviderErrorTranscriptMarkdown,
  resolveChatErrorPresentation,
} from "./chatErrorPresentation";

describe("chatErrorPresentation", () => {
  it("routes Macro errors to the composer", () => {
    const presentation = resolveChatErrorPresentation(
      new Error("Task worktree is not ready yet."),
    );

    expect(presentation.origin).toBe("macro");
    expect(presentation.displayTarget).toBe("composer");
    expect(presentation.message).toBe("Task worktree is not ready yet.");
  });

  it("routes provider errors to the transcript with request details", () => {
    const providerError = Object.assign(new Error("rate limit exceeded"), {
      name: "ProviderRuntimeError",
      providerError: true,
      kind: "rate_limited",
      status: 429,
      retryable: true,
      retryAfterMs: 30000,
      providerMessage: "You exceeded your current quota.",
      providerCode: "rate_limit_exceeded",
      providerType: "insufficient_quota",
      providerRawBodyExcerpt:
        '{"error":{"message":"You exceeded your current quota.","code":"rate_limit_exceeded"}}',
    });

    const presentation = resolveChatErrorPresentation(providerError, {
      providerId: "openai-main",
      providerType: "openai",
      modelId: "gpt-test",
    });
    const markdown = buildProviderErrorTranscriptMarkdown(presentation);

    expect(presentation.origin).toBe("provider");
    expect(presentation.displayTarget).toBe("transcript");
    expect(markdown).toContain("### Erreur du provider");
    expect(markdown).toContain("Provider: `openai-main`");
    expect(markdown).toContain("Modèle: `gpt-test`");
    expect(markdown).toContain("Statut HTTP: `429`");
    expect(markdown).toContain("Code: `rate_limit_exceeded`");
    expect(markdown).toContain("You exceeded your current quota.");
  });

  it("gives an actionable hint for invalid tool protocol provider errors", () => {
    const providerError = Object.assign(new Error("tool protocol rejected"), {
      name: "ProviderRuntimeError",
      providerError: true,
      kind: "invalid_tool_protocol",
      status: 400,
      retryable: false,
      providerMessage:
        "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
    });

    const presentation = resolveChatErrorPresentation(providerError);

    expect(presentation.suggestedAction).toContain("compaction stricte");
    expect(presentation.suggestedAction).toContain("historique d'outils");
  });
});
