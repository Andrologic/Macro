import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ArchitectStrategyPanel from "./ArchitectStrategyPanel";
import { useAppStore } from "../../stores/useAppStore";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { createExample } from "../../services/agsdl/examples";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const originalApp = useAppStore.getState();
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  useAppStore.setState(originalApp);
  useAgsdlStore.setState({ sessions: {} });
});

const mount = async () => {
  const target = { branchName: "develop", planId: "layout-test" };
  useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: {
    source: createExample("release"), annexes: {}, version: "v1", persistedRevision: 0,
    dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null,
  } } });
  useAppStore.setState({ activeArchitectPlanId: target.planId, activePlanContext: {
    id: target.planId, targetBranch: "develop", status: "draft",
  } as NonNullable<ReturnType<typeof useAppStore.getState>["activePlanContext"]>, rightPanelWidth: 320, isLeftPanelOpen: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ArchitectStrategyPanel />));
  return container.querySelector<HTMLButtonElement>(".agsdl-viewer-header button")!;
};

it("opens the graph in a portal modal and closes without changing the panels or document", async () => {
  const expand = await mount();
  for (const close of ["button", "escape", "backdrop"]) {
    expand.focus();
    await act(async () => expand.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(container!.contains(dialog)).toBe(false);
    expect(dialog.querySelectorAll(".agsdl-graph-node")).toHaveLength(5);
    expect(useAppStore.getState().rightPanelWidth).toBe(320);
    expect(useAppStore.getState().isLeftPanelOpen).toBe(true);
    act(() => {
      if (close === "button") dialog.querySelector<HTMLButtonElement>(".agsdl-viewer-header button")!.click();
      if (close === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (close === "backdrop") dialog.parentElement!.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(expand);
    expect(container!.hasAttribute("inert")).toBe(false);
  }
  expect(Object.values(useAgsdlStore.getState().sessions)[0].dirty).toBe(false);
});

it("removes the expanded view and releases the background when the active plan is cleared", async () => {
  const expand = await mount();
  await act(async () => expand.click());
  expect(container!.hasAttribute("inert")).toBe(true);
  act(() => useAppStore.setState({ activeArchitectPlanId: null, activePlanContext: null }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container!.hasAttribute("inert")).toBe(false);
  expect(useAppStore.getState().rightPanelWidth).toBe(320);
  expect(useAppStore.getState().isLeftPanelOpen).toBe(true);
  act(() => useAppStore.setState({ activeArchitectPlanId: "layout-test", activePlanContext: {
    id: "layout-test", targetBranch: "develop", status: "draft",
  } as NonNullable<ReturnType<typeof useAppStore.getState>["activePlanContext"]> }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
