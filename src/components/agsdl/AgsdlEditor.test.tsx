import { afterEach, describe, expect, it, spyOn, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgsdlEditor } from "./AgsdlEditor";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import * as chatContext from "../../stores/agsdl/chatContext";
import { createLegacyExample, createExample } from "../../services/agsdl/examples";
import { useAgsdlExecutionStore } from "../../stores/useAgsdlExecutionStore";
import { useChatStore } from "../../stores/useChatStore";
import type { PublicSnapshot, SourceRevision } from "../../services/agsdlExecution/contracts";

const target = { branchName: "develop", planId: "viewer-test" };
const key = agsdlSessionKey(target);
let root: Root | undefined;
let container: HTMLDivElement | undefined;
const inspectNode = async (node: HTMLButtonElement) => act(async () => {
  node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
});
afterEach(() => {
  act(() => root?.unmount());
  mock.restore();
  container?.remove();
  useAgsdlStore.setState({ sessions: {} });
  useAgsdlExecutionStore.setState({ owner: undefined, snapshot: undefined, projection: undefined, preflight: undefined, captured: false });
  useChatStore.setState({ selectedConversationId: null, conversations: [] });
});

describe("AgSDL viewer", () => {
  const mount = async (source = createLegacyExample("feature")) => {
    // Document validation is tested in the service suite. Keep explicitly injected
    // diagnostics stable while testing the modal's asynchronous retry behavior.
    spyOn(useAgsdlStore.getState(), "validate").mockResolvedValue(undefined);
    useAgsdlStore.setState({ sessions: { [key]: {
      source, annexes: {}, version: "v1", persistedRevision: 1,
      dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null,
    } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<AgsdlEditor target={target} />));
  };

  it("reads 0.2 metadata and opens the persistent participant without creating a task from its prompt", async () => {
    const source = createExample("feature");
    await mount(source);
    act(() => useAgsdlStore.setState(state => ({ sessions: { ...state.sessions, [key]: { ...state.sessions[key], display: { title: "Feature review", cards: { "/flow/steps/specify": { title: "Specification visit" } } } } } })));
    expect(container!.querySelector("header strong")?.textContent).toBe("Feature review");
    const first = container!.querySelector<HTMLButtonElement>(".agsdl-graph-node")!;
    expect(first.textContent).toContain("Specification visit");
    act(() => first.click());
    expect(document.body.querySelector(".agsdl-agent-details")).toBeNull();
    await inspectNode(first);
    expect(document.body.querySelector(".agsdl-agent-details")?.textContent).toContain("acceptance criteria");
    expect(document.body.querySelector(".agsdl-reference-chip")?.textContent).toContain("specify");
    expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
  });

  it("keeps Architect on the authored document even when an execution capture is selected", async () => {
    const authoredSource = createExample("feature");
    const currentDocument = JSON.parse(authoredSource);
    const agent = Object.keys(currentDocument.agents)[0];
    currentDocument.agents[agent].prompt = [{ value: "Current draft prompt" }];
    const currentSource = JSON.stringify(currentDocument);
    await mount(currentSource);
    const owner = { projectId: "viewer-project", planId: target.planId, branch: target.branchName };
    const source = { owner, revision: "1", sourceSha256: "a".repeat(64) } as SourceRevision;
    const snapshot = { source, authoredSource, systemStartId: "viewer-run" } as PublicSnapshot;
    const watch = spyOn(useAgsdlExecutionStore.getState(), "watch");
    act(() => {
      useChatStore.setState({ selectedConversationId: "viewer-conversation", conversations: [{ id: "viewer-conversation", project_id: owner.projectId } as ReturnType<typeof useChatStore.getState>["conversations"][number]] });
      useAgsdlExecutionStore.setState({ owner, conversationId: "viewer-conversation", snapshot, captured: true });
    });
    expect(watch).not.toHaveBeenCalled();
    expect(container!.querySelector(".agsdl-native-dot, .agsdl-graph-caption")).toBeNull();
    const header = container!.querySelector(".agsdl-viewer-header")!;
    expect([...header.querySelectorAll("button")]).toHaveLength(0);
    await inspectNode(container!.querySelector<HTMLButtonElement>(".agsdl-graph-node")!);
    expect(document.body.querySelector(".agsdl-prompt")?.textContent).toBe("Current draft prompt");
    expect(document.body.querySelector('[aria-label="Edit component"]')).not.toBeNull();
    expect(useAgsdlStore.getState().sessions[key].source).toBe(currentSource);
  });

  it("returns from the expanded graph only after attaching context successfully", async () => {
    await mount();
    const closeExpanded = mock(() => undefined);
    const attach = spyOn(chatContext, "prepareAgsdlChatContext").mockRejectedValueOnce(new Error("Storage unavailable"));
    await act(async () => root!.render(<AgsdlEditor target={target} expanded onExpand={closeExpanded} />));
    await inspectNode(container!.querySelector<HTMLButtonElement>(".agsdl-graph-node")!);
    const button = document.body.querySelector<HTMLButtonElement>('[aria-label="Attach to chat"]')!;
    await act(async () => button.click());
    expect(closeExpanded).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("The action failed. Try again.");
    expect(document.body.textContent).not.toContain("Storage unavailable");
    attach.mockResolvedValueOnce(undefined);
    await act(async () => button.click());
    expect(closeExpanded).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".agsdl-detail-modal")).toBeNull();
  });

  it("attaches a localized diagnostic through the same chat return path and preserves failures", async () => {
    await mount();
    const closeExpanded = mock(() => undefined);
    const attach = spyOn(chatContext, "prepareAgsdlChatContext").mockRejectedValueOnce(new Error("agsdl.chatConversationMissing"));
    act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: { ...state.sessions[key], reports: [{ operation: "inspect", results: [{ input: "primary", unit: "test", verdict: "fail", findings: [
      { rule: "resource-rule", outcome: "fail", details: "Check this resource", location: { pointer: "/graphs/0/steps/0/resources/0" } },
      { rule: "unknown-rule", outcome: "fail", details: "Unknown location", location: { pointer: "/missing" } },
    ] }] }] } } })));
    await act(async () => root!.render(<AgsdlEditor target={target} expanded onExpand={closeExpanded} />));
    await inspectNode(container!.querySelector<HTMLButtonElement>(".agsdl-graph-node")!);
    const button = [...document.body.querySelectorAll<HTMLButtonElement>(".agsdl-inspector button")].find(button => button.textContent === "Prepare correction in chat")!;
    await act(async () => button.click());
    expect(attach).toHaveBeenCalledWith(target, { path: "/graphs/0/steps/0/resources/0", title: "Specification", diagnostic: "resource-rule: Check this resource" });
    expect(closeExpanded).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Open this plan");
    attach.mockResolvedValueOnce(undefined);
    await act(async () => button.click());
    expect(closeExpanded).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".agsdl-detail-modal")).toBeNull();
  });

  it("keeps agent prompts, input provenance and output recipients in focused details", async () => {
    await mount();
    const nodes = [...container!.querySelectorAll<HTMLButtonElement>(".agsdl-graph-node")];
    expect(nodes).toHaveLength(3);
    expect(container!.querySelector(".is-boundary, .react-flow__edge-text")).toBeNull();
    expect(globalThis.document.body.querySelector(".agsdl-inspector")).toBeNull();
    await inspectNode(nodes[0]);
    const agentDetails = globalThis.document.body.querySelector(".agsdl-inspector")!;
    expect(agentDetails.querySelector(".agsdl-prompt")?.textContent).toBe("Clarify the request and produce acceptance criteria.");
    expect(agentDetails.querySelector(".agsdl-agent-io")?.textContent).toContain("System input");
    expect(agentDetails.querySelector(".agsdl-agent-io")?.textContent).toContain("Implementation");
    expect(agentDetails.querySelector(".agsdl-properties")).toBeNull();
  });

  it("previews a linked agent on focus and opens its modal on click without changing source", async () => {
    await mount();
    const agents = container!.querySelectorAll<HTMLButtonElement>(".agsdl-graph-node");
    await inspectNode(agents[1]);
    const input = document.body.querySelector<HTMLButtonElement>(".agsdl-agent-io .agsdl-reference-chip")!;
    act(() => input.focus());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain("acceptance criteria");
    expect(input.getAttribute("aria-describedby")).toBe(document.body.querySelector('[role="tooltip"]')?.id ?? null);
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.body.querySelector(".agsdl-detail-modal")).not.toBeNull();
    act(() => input.click());
    expect(document.body.querySelector(".agsdl-detail-modal > header strong")?.textContent).toBe("Specification");
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    const output = document.body.querySelector<HTMLButtonElement>(".agsdl-agent-io .agsdl-reference-chip")!;
    act(() => output.click());
    expect(document.body.querySelector(".agsdl-detail-modal > header strong")?.textContent).toBe("Implementation");
    expect(useAgsdlStore.getState().sessions[key].source).toBe(createLegacyExample("feature"));
  });

  it("keeps saved graphs quiet while preserving validation and unsaved-work notices", async () => {
    await mount();
    expect(container!.querySelector(".agsdl-status, .agsdl-graph-caption")).toBeNull();
    act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: {
      ...state.sessions[key], dirty: true,
      reports: [{ operation: "validate", results: [{ input: "graph", unit: "test", verdict: "fail", findings: [
        { rule: "missing-agent", outcome: "fail", details: "Unknown agent reference", location: {} },
      ] }] }],
    } } })));
    expect(container!.querySelector('[role="status"]')).not.toBeNull();
    expect(container!.querySelector('[aria-label="Undo"], [aria-label="Redo"]')).toBeNull();
    expect(container!.querySelector('[aria-label="System details"]')).toBeNull();
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
    const document = JSON.parse(createLegacyExample("feature"));
    document.graphs.push(...["second", "third"].map(id => ({ ...structuredClone(document.graphs[0]), id })));
    await mount(JSON.stringify(document));
    const selector = container!.querySelector("select")!;
    await inspectNode(container!.querySelector<HTMLButtonElement>(".agsdl-graph-node")!);
    expect(globalThis.document.body.querySelector(".agsdl-inspector")).not.toBeNull();
    act(() => { selector.value = "2"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(globalThis.document.body.querySelector(".agsdl-inspector")).toBeNull();
    document.graphs.pop();
    act(() => useAgsdlStore.getState().replace(target, JSON.stringify(document)));
    expect(selector.value).toBe("1");
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
      expect(useAgsdlStore.getState().sessions[key].source).toBe(createLegacyExample("feature"));
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
          source: createLegacyExample("feature"),
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
    expect(container.querySelectorAll(".agsdl-graph-node")).toHaveLength(3);
    expect(globalThis.document.body.querySelector(".agsdl-inspector")).toBeNull();
    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand view"]',
    )!;
    act(() => expand.click());
    expect(expanded).toBe(true);
    const headerButtons = [...container.querySelectorAll<HTMLButtonElement>(".agsdl-viewer-header button")];
    expect(headerButtons).toHaveLength(1);
    expect(headerButtons[0]).toBe(expand);
    expect(container.querySelector('[aria-label="Executions"], [aria-label="System details"], [aria-label="Save as blueprint"]')).toBeNull();
    const firstCard = container.querySelector<HTMLButtonElement>(
      ".agsdl-graph-node:not(.is-boundary)",
    )!;
    await inspectNode(firstCard);
    expect(globalThis.document.body.querySelector(".agsdl-inspector")?.textContent).toContain("Clarify the request and produce acceptance criteria.");
    const nextNode = container.querySelectorAll<HTMLButtonElement>(".agsdl-graph-node:not(.is-boundary)")[1];
    await inspectNode(nextNode);
    const nextDetails = globalThis.document.body.querySelector(".agsdl-inspector")!;
    expect(nextDetails.querySelector(".agsdl-prompt")?.textContent).toBeTruthy();
    expect(nextDetails.textContent).not.toContain("Specification · report");
    expect(useAgsdlStore.getState().sessions[key].source).toBe(createLegacyExample("feature"));
    expect(
      container.querySelector("textarea, input, [role=dialog]"),
    ).toBeNull();
  });
});
