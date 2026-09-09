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

  it("keeps custom end titles and shows the outcome only once for unnamed ends", async () => {
    const document = JSON.parse(createExample("feature"));
    const ends = document.graphs[0].steps.filter((step: { kind: string }) => step.kind === "end");
    ends[0].annotations = { title: "Ready for delivery" };
    await mount(JSON.stringify(document));
    const cards = [...container!.querySelector(".agsdl-reading")!.children]
      .filter(element => element.classList.contains("agsdl-card"));
    const namedEnd = cards.find(card => card.querySelector("h3")?.textContent === "Ready for delivery");
    expect(namedEnd).toBeDefined();
    expect(namedEnd!.querySelector("p")).not.toBeNull();
    const lastEnd = cards.at(-1)!;
    expect(lastEnd.querySelector("h3")).not.toBeNull();
    expect([...lastEnd.children].filter(element =>
      element.tagName === "P" && element.textContent === lastEnd.querySelector("h3")!.textContent,
    )).toHaveLength(0);
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
    act(() => container!.querySelector<HTMLButtonElement>(".agsdl-card-heading")!.click());
    expect(container!.querySelector(".agsdl-card-selected")).not.toBeNull();
    act(() => { selector.value = "2"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container!.querySelector(".agsdl-card-selected")).toBeNull();
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
    expect(container.textContent).toContain(
      "Clarify the request and produce acceptance criteria.",
    );
    expect(container.textContent).toContain("Specification · report");
    expect(container.querySelectorAll(".agsdl-branches").length).toBe(3);
    const expand = container.querySelector<HTMLButtonElement>(
      ".agsdl-viewer-header button",
    )!;
    act(() => expand.click());
    expect(expanded).toBe(true);
    const firstCard = container.querySelector<HTMLButtonElement>(
      ".agsdl-card-heading",
    )!;
    act(() => firstCard.click());
    expect(container.querySelector(".agsdl-properties")).not.toBeNull();
    expect(
      container.querySelector("textarea, input, [role=dialog]"),
    ).toBeNull();
  });
});
