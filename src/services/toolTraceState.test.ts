import { describe, expect, it } from "bun:test";
import {
  classifyToolTraceRecovery,
  mergeToolTracesPreservingDeniedStatus,
  parseToolTracesJson,
} from "./toolTraceState";

describe("toolTraceState", () => {
  it("keeps interrupted effects unknown unless a durable result or approval marker proves otherwise", () => {
    const running = { tool_call_id: 'call-1', tool_name: 'terminal_run', status: 'running' as const };
    expect(classifyToolTraceRecovery(running)).toBe('unknown');
    expect(classifyToolTraceRecovery(running, { live: true })).toBe('live');
    expect(classifyToolTraceRecovery({ ...running, status: 'done' })).toBe('completed');
    const approval = { ...running, status: 'pending_approval' as const };
    expect(classifyToolTraceRecovery(approval)).toBe('unknown');
    expect(classifyToolTraceRecovery(approval, { approvalRecovered: true })).toBe('replayable');
    expect(parseToolTracesJson(JSON.stringify([running]))?.[0]?.recovery_state).toBe('unknown');
  });
  it("parses persisted tool traces including pending approval and denied statuses", () => {
    const parsed = parseToolTracesJson(
      JSON.stringify([
        {
          tool_call_id: "tool-1",
          tool_name: "terminal_run",
          status: "pending_approval",
        },
        {
          tool_call_id: "tool-2",
          tool_name: "web_fetch",
          status: "denied",
        },
        {
          tool_call_id: "tool-3",
          tool_name: "broken",
          status: "unknown",
        },
      ]),
    );

    expect(parsed).toEqual([
      {
        tool_call_id: "tool-1",
        tool_name: "terminal_run",
        status: "pending_approval",
        recovery_state: "unknown",
      },
      {
        tool_call_id: "tool-2",
        tool_name: "web_fetch",
        status: "denied",
        recovery_state: "completed",
      },
    ]);
  });

  it("preserves denied tool traces when a later stream completion arrives", () => {
    expect(
      mergeToolTracesPreservingDeniedStatus(
        [
          {
            tool_call_id: "tool-1",
            tool_name: "terminal_run",
            status: "done",
          },
          {
            tool_call_id: "tool-2",
            tool_name: "read",
            status: "done",
          },
        ],
        [
          {
            tool_call_id: "tool-1",
            tool_name: "terminal_run",
            status: "denied",
          },
          {
            tool_call_id: "tool-2",
            tool_name: "read",
            status: "running",
          },
        ],
      ),
    ).toEqual([
      {
        tool_call_id: "tool-1",
        tool_name: "terminal_run",
        status: "denied",
      },
      {
        tool_call_id: "tool-2",
        tool_name: "read",
        status: "done",
      },
    ]);
  });

  it("does not downgrade an existing done trace when a stale running trace arrives", () => {
    expect(
      mergeToolTracesPreservingDeniedStatus(
        [
          {
            tool_call_id: "tool-1",
            tool_name: "read",
            status: "running",
          },
        ],
        [
          {
            tool_call_id: "tool-1",
            tool_name: "read",
            status: "done",
            completed_at_ms: 123,
          },
        ],
      ),
    ).toEqual([
      {
        tool_call_id: "tool-1",
        tool_name: "read",
        status: "done",
        completed_at_ms: 123,
      },
    ]);
  });
});
