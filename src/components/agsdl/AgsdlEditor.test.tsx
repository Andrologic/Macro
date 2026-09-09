import { afterEach, describe, expect, it } from "bun:test";
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
