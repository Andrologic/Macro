import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ArchitectStrategyPanel from "./ArchitectStrategyPanel";
import { useAppStore } from "../../stores/useAppStore";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const originalApp = useAppStore.getState();
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  useAppStore.setState(originalApp);
  useAgsdlStore.setState({ sessions: {} });
});

it("restores the panels when leaving an expanded Architect viewer", async () => {
  const target = { branchName: "develop", planId: "layout-test" };
  useAgsdlStore.setState({ sessions: { [agsdlSessionKey(target)]: {
    source: "", annexes: {}, version: "v1", persistedRevision: 0,
    dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null,
  } } });
  useAppStore.setState({ activeArchitectPlanId: target.planId, activePlanContext: {
    id: target.planId, targetBranch: "develop", status: "draft",
  } as NonNullable<ReturnType<typeof useAppStore.getState>["activePlanContext"]>, rightPanelWidth: 320, isLeftPanelOpen: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ArchitectStrategyPanel />));
  act(() => container!.querySelector<HTMLButtonElement>(".agsdl-viewer-header button")!.click());
  expect(useAppStore.getState().isLeftPanelOpen).toBe(false);
  act(() => root!.render(null));
  expect(useAppStore.getState().rightPanelWidth).toBe(320);
  expect(useAppStore.getState().isLeftPanelOpen).toBe(true);
});
