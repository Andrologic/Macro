import { describe, expect, it } from "bun:test";
import {
  applyEditingStrategyToToolIds,
  shouldPreferApplyPatchForModel,
} from "./aiEditingStrategy";

describe("aiEditingStrategy", () => {
  it("prefers apply_patch for recent GPT and Codex families", () => {
    expect(shouldPreferApplyPatchForModel("openai", "gpt-5")).toBe(true);
    expect(shouldPreferApplyPatchForModel("chatgpt", "gpt-5.1")).toBe(true);
    expect(shouldPreferApplyPatchForModel("openrouter", "openai/gpt-4.1")).toBe(
      true,
    );
    expect(
      shouldPreferApplyPatchForModel("openrouter", "openai/codex-mini-latest"),
    ).toBe(true);
  });

  it("keeps legacy write/edit strategy for other providers or older models", () => {
    expect(shouldPreferApplyPatchForModel("anthropic", "claude-sonnet-4")).toBe(
      false,
    );
    expect(shouldPreferApplyPatchForModel("openai", "o3")).toBe(false);
    expect(shouldPreferApplyPatchForModel("openai", null)).toBe(false);
  });

  it("exposes only one editing family at a time", () => {
    expect(
      applyEditingStrategyToToolIds(
        ["read", "write", "edit", "apply_patch"],
        "openai",
        "gpt-5",
      ),
    ).toEqual(["read", "apply_patch"]);
    expect(
      applyEditingStrategyToToolIds(
        ["read", "write", "edit", "apply_patch"],
        "anthropic",
        "claude",
      ),
    ).toEqual(["read", "write", "edit"]);
  });
});
