import { describe, expect, it } from "bun:test";
import { TOOL_OUTPUT_LIMITS } from "../shared/toolOutputLimits";
import {
  buildSpilledToolResultPreview,
  shouldSpillToolResult,
} from "./toolResultArtifacts";

describe("toolResultArtifacts", () => {
  it("spills only oversized non-read_file text", () => {
    const oversized = "x".repeat(
      TOOL_OUTPUT_LIMITS.toolResult.spillThresholdBytes + 1,
    );
    expect(shouldSpillToolResult("terminal_run", oversized)).toBe(true);
    expect(shouldSpillToolResult("read_file", oversized)).toBe(false);
    expect(shouldSpillToolResult("terminal_run", "small")).toBe(false);
  });

  it("keeps a bounded head and tail with a recovery path", () => {
    const result = `HEAD-${"x".repeat(70_000)}-TAIL`;
    const preview = buildSpilledToolResultPreview({
      toolName: "terminal_run",
      result,
      artifactPath: "tool-output://conversation/call",
    });

    expect(preview.preview).toStartWith("HEAD-");
    expect(preview.preview).toEndWith("-TAIL");
    expect(preview.preview).toContain("Full output: tool-output://conversation/call");
    expect(preview.omittedBytes).toBeGreaterThan(0);
    expect(new TextEncoder().encode(preview.preview).byteLength).toBeLessThan(
      TOOL_OUTPUT_LIMITS.toolResult.spillThresholdBytes,
    );
  });
});
