import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgsdlEditor } from "./AgsdlEditor";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { createExample } from "../../services/agsdl/examples";

const target = { branchName: "develop", planId: "viewer-test" };
const key = agsdlSessionKey(target);
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  useAgsdlStore.setState({ sessions: {} });
});

describe("AgSDL viewer", () => {
  const mount = async (source = createExample("feature")) => {
    useAgsdlStore.setState({ sessions: { [key]: {
      source, annexes: {}, version: "v1", persistedRevision: 1,
      dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null,
    } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<AgsdlEditor target={target} />));
  };

  it("shows boundary icons with accessible data and keeps the named result in details", async () => {
    const document = JSON.parse(createExample("feature"));
    const ends = document.graphs[0].steps.filter((step: { kind: string }) => step.kind === "end");
    ends[0].annotations = { title: "Ready for delivery" };
    await mount(JSON.stringify(document));
    const nodes = [...container!.querySelectorAll<HTMLButtonElement>(".agsdl-graph-node")];
    const boundaries = nodes.filter(node => node.classList.contains("is-boundary"));
    expect(boundaries.map(node => node.textContent)).toEqual(["", ""]);
    expect(boundaries[0].getAttribute("aria-label")).toContain("brief · context");
    expect(boundaries[1].getAttribute("aria-label")).toContain("report");
    expect(boundaries.every(node => node.querySelector(".agsdl-node-icon"))).toBe(true);
    expect(container!.querySelector(".react-flow__edge-text")).toBeNull();
    expect(boundaries[1].title).toContain("Ready for delivery");
    expect(nodes).toHaveLength(5);
    expect(container!.querySelector(".agsdl-inspector")).toBeNull();
    act(() => boundaries[1].click());
    expect(container!.querySelector(".agsdl-inspector")!.textContent).toContain("Ready for delivery");
  });

  it("keeps saved graphs quiet while preserving validation and unsaved-work notices", async () => {
    await mount();
    expect(container!.querySelector(".agsdl-status, .agsdl-graph-caption, .agsdl-header-actions button")).toBeNull();
    act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: {
      ...state.sessions[key], dirty: true,
      reports: [{ operation: "validate", results: [{ input: "graph", unit: "test", verdict: "fail", findings: [
        { rule: "missing-agent", outcome: "fail", details: "Unknown agent reference", location: {} },
      ] }] }],
    } } })));
    expect(container!.querySelector('[role="status"]')).not.toBeNull();
    act(() => container!.querySelector<HTMLButtonElement>(".agsdl-header-actions button")!.click());
    expect(container!.querySelector(".agsdl-inspector")!.textContent).toContain("Unknown agent reference");
  });

  it("keeps an unreadable document recoverable through chat with technical details collapsed", async () => {
    await mount("{broken");
    const alert = container!.querySelector("[role=alert]")!;
    expect(alert.querySelector("p")!.textContent).toContain("AgSDL");
    expect(alert.querySelector("details")!.open).toBe(false);
    expect(alert.querySelector("details")!.textContent).toContain("Invalid JSON");
    expect(alert.querySelector("button")).toBeNull();
    expect(container!.querySelector("input, textarea")).toBeNull();
  });

  it("resets details on graph navigation and clamps the selector after agent changes", async () => {
    const document = JSON.parse(createExample("feature"));
    document.graphs.push(...["second", "third"].map(id => ({ ...structuredClone(document.graphs[0]), id })));
    await mount(JSON.stringify(document));
    const selector = container!.querySelector("select")!;
    act(() => container!.querySelector<HTMLButtonElement>(".agsdl-graph-node")!.click());
    expect(container!.querySelector(".agsdl-inspector")).not.toBeNull();
    act(() => { selector.value = "2"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container!.querySelector(".agsdl-inspector")).toBeNull();
    document.graphs.pop();
    act(() => useAgsdlStore.getState().replace(target, JSON.stringify(document)));
    expect(selector.value).toBe("1");
  });

  it("keeps technical fields collapsed and resets them when selecting another agent", async () => {
    await mount();
    const agents = container!.querySelectorAll<HTMLButtonElement>(".agsdl-graph-node:not(.is-boundary)");
    act(() => agents[1].click());
    const inspector = container!.querySelector(".agsdl-inspector")!;
    const summary = inspector.querySelector(".agsdl-exchange-summary")!;
    expect(summary.textContent).toContain("Specification · report");
    expect(summary.textContent).not.toContain("string");
    const technical = inspector.querySelector("details")!;
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain("string");
    technical.open = true;
    act(() => agents[2].click());
    expect(container!.querySelector(".agsdl-inspector details")!.hasAttribute("open")).toBe(false);
    act(() => container!.querySelector(".agsdl-inspector button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container!.querySelector(".agsdl-inspector")).toBeNull();
    expect(useAgsdlStore.getState().sessions[key].dirty).toBe(false);
  });

  it("retries saving the agent draft without reloading it", async () => {
    await mount();
    act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: { ...state.sessions[key], dirty: true, error: "Save failed" } } })));
    const store = useAgsdlStore.getState();
    const save = spyOn(store, "save").mockResolvedValue();
    const load = spyOn(store, "load");
    const validate = spyOn(store, "validate").mockResolvedValue();
    try {
      await act(async () => container!.querySelector<HTMLButtonElement>("[role=alert] button")!.click());
      expect(save).toHaveBeenCalledWith(target);
      expect(load).not.toHaveBeenCalled();
      expect(validate).toHaveBeenCalledWith(target);
      expect(useAgsdlStore.getState().sessions[key].source).toBe(createExample("feature"));
    } finally { save.mockRestore(); load.mockRestore(); validate.mockRestore(); }
  });

  it("reloads a clean failed session when retrying", async () => {
    await mount();
    act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: { ...state.sessions[key], error: "Validation unavailable" } } })));
    const store = useAgsdlStore.getState();
    const load = spyOn(store, "load").mockResolvedValue(store.sessions[key]);
    const validate = spyOn(store, "validate").mockResolvedValue();
    try {
      await act(async () => container!.querySelector<HTMLButtonElement>("[role=alert] button")!.click());
      expect(load).toHaveBeenCalledWith(target, true);
    } finally { load.mockRestore(); validate.mockRestore(); }
  });

  it("shows routes and missions without editing controls and delegates expansion to the shell", async () => {
    useAgsdlStore.setState({
      sessions: {
        [key]: {
          source: createExample("feature"),
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
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    let expanded = false;
    await act(async () => {
      root!.render(
        <AgsdlEditor
          target={target}
          onExpand={() => {
            expanded = true;
          }}
        />,
      );
    });
    expect(
      container.querySelector("textarea, input, select, [role=dialog]"),
    ).toBeNull();
    expect(container.textContent).not.toContain("Clarify the request and produce acceptance criteria.");
    expect(container.textContent).not.toContain("Specification · report");
    expect(container.querySelectorAll(".agsdl-graph-node")).toHaveLength(5);
    expect(container.querySelector(".agsdl-inspector")).toBeNull();
    const expand = container.querySelector<HTMLButtonElement>(
      ".agsdl-viewer-header button",
    )!;
    act(() => expand.click());
    expect(expanded).toBe(true);
    const firstCard = container.querySelector<HTMLButtonElement>(
      ".agsdl-graph-node:not(.is-boundary)",
    )!;
    act(() => firstCard.click());
    expect(container.querySelector(".agsdl-inspector")?.textContent).toContain("Clarify the request and produce acceptance criteria.");
    const nextNode = container.querySelectorAll<HTMLButtonElement>(".agsdl-graph-node:not(.is-boundary)")[1];
    act(() => nextNode.click());
    expect(container.querySelector(".agsdl-inspector")?.textContent).toContain("Specification · report");
    expect(
      container.querySelector("textarea, input, [role=dialog]"),
    ).toBeNull();
  });
});
