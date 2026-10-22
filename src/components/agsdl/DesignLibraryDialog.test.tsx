import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DesignLibraryDialog } from "./DesignLibraryDialog";
import * as blueprints from "../../stores/agsdl/blueprints";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";

const target = { branchName: "develop", planId: "design-library" };
const key = agsdlSessionKey(target);
const originalSave = useAgsdlStore.getState().save;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  mock.restore();
  host?.remove();
  useAgsdlStore.setState({ sessions: {}, save: originalSave });
  root = undefined;
  host = undefined;
});

const mount = async (onClose = () => {}, onCreated = () => {}) => {
  useAgsdlStore.setState({ sessions: { [key]: {
    source: "",
    annexes: {},
    version: "v1",
    persistedRevision: 1,
    dirty: false,
    saving: false,
    status: "draft",
    history: [],
    future: [],
    reports: [],
    error: null,
  } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<DesignLibraryDialog target={target} mode="blueprint" onClose={onClose} onCreated={onCreated} />);
    await Promise.resolve();
    await Promise.resolve();
  });
};

const setSearch = (value: string) => act(() => {
  const input = document.body.querySelector<HTMLInputElement>(".agsdl-design-search")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("design source library", () => {
  it("keeps healthy sources visible, invalidates filtered selections, and retries a partial load", async () => {
    const original = blueprints.builtInDesignSources()[0];
    const source = { ...original, display: { ...original.display, cards: { "/flow/steps/checklist": { title: "Checklist" } } } };
    let resolveRetry!: (result: Awaited<ReturnType<typeof blueprints.listDesignSources>>) => void;
    const retryResult = new Promise<Awaited<ReturnType<typeof blueprints.listDesignSources>>>(resolve => { resolveRetry = resolve; });
    const list = spyOn(blueprints, "listDesignSources")
      .mockResolvedValueOnce({ sources: [source], failureCount: 1 })
      .mockReturnValueOnce(retryResult);
    await mount();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    const sourceButton = document.body.querySelector<HTMLButtonElement>(".agsdl-design-source")!;
    act(() => sourceButton.click());
    expect(document.body.querySelector(".agsdl-design-preview")?.textContent).toContain("Checklist");
    expect(document.body.querySelector(".agsdl-design-preview-pending")?.textContent).toBe("1 item to complete");

    setSearch("Feature");
    expect(document.body.querySelector(".agsdl-design-source")).toBeNull();
    expect(document.body.querySelector(".agsdl-design-preview")).toBeNull();
    expect(document.body.querySelector<HTMLButtonElement>("footer button:last-child")!.disabled).toBe(true);

    setSearch("");
    act(() => document.body.querySelector<HTMLButtonElement>(".agsdl-design-source")!.click());
    const retry = document.body.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector<HTMLInputElement>(".agsdl-design-search")!.disabled).toBe(true);
    expect(document.body.querySelector<HTMLButtonElement>("footer button:last-child")!.disabled).toBe(true);
    await act(async () => {
      resolveRetry({ sources: [source], failureCount: 0 });
      await retryResult;
      await Promise.resolve();
    });
    expect(document.body.querySelector<HTMLInputElement>(".agsdl-design-search")!.disabled).toBe(false);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.querySelector<HTMLButtonElement>("footer button:last-child")!.disabled).toBe(false);
  });

  it("locks the library during persistence and calls onCreated only after a successful copy", async () => {
    const source = blueprints.builtInDesignSources()[0];
    spyOn(blueprints, "listDesignSources").mockResolvedValue({ sources: [source], failureCount: 0 });
    let attempts = 0;
    const save = spyOn(useAgsdlStore.getState(), "save").mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Persistence unavailable");
    });
    const events: string[] = [];
    await mount(() => events.push("closed"), () => events.push("created"));
    act(() => document.body.querySelector<HTMLButtonElement>(".agsdl-design-source")!.click());

    const search = document.body.querySelector<HTMLInputElement>(".agsdl-design-search")!;
    const create = document.body.querySelector<HTMLButtonElement>("footer button:last-child")!;
    await act(async () => {
      create.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(search.disabled).toBe(true);
    expect(create.textContent).toContain("Retry");

    await act(async () => {
      create.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["created", "closed"]);
  });
});
