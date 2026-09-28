import { afterEach, describe, expect, it, mock } from "bun:test";

const reserve = mock((_runId: string, _parentConversationId: string): Promise<string> =>
  Promise.resolve("child-1"));
const available = mock(() => true);
mock.module("../ipc/goalAudit", () => ({ reserveGoalAuditChildConversation: reserve }));
mock.module("../ipc/runtime", () => ({ isTauriAvailable: available }));

const { resolveNativeGoalAuditChildConversation: resolveChild } = await import("./nativeChildConversation");
const request = (signal = new AbortController().signal) => ({
  runId: "run-1", parentConversationId: "parent-1", signal,
});

afterEach(() => {
  reserve.mockReset();
  reserve.mockImplementation(async () => "child-1");
  available.mockReset();
  available.mockImplementation(() => true);
});

describe("native goal audit child conversation resolver", () => {
  it("returns the reserved conversation with its run and parent binding", async () => {
    expect(await resolveChild(request())).toEqual({
      id: "child-1", runId: "run-1", parentConversationId: "parent-1",
    });
    expect(reserve).toHaveBeenCalledWith("run-1", "parent-1");
  });

  it("fails closed outside the Tauri runtime", async () => {
    available.mockReturnValue(false);
    await expect(resolveChild(request())).rejects.toThrow("requires Tauri");
    expect(reserve).not.toHaveBeenCalled();
  });

  it("does not reserve when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolveChild(request(controller.signal))).rejects.toHaveProperty("name", "AbortError");
    expect(reserve).not.toHaveBeenCalled();
  });

  it("does not return a reservation completed after abort", async () => {
    let finish!: (id: string) => void;
    reserve.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = resolveChild(request(controller.signal));
    controller.abort();
    finish("child-1");
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(reserve).toHaveBeenCalledTimes(1);
  });
});
