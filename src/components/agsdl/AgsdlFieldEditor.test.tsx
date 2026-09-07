import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgsdlDraftTarget, JsonEditor } from "./AgsdlFieldEditor";
import {
  agsdlSessionKey,
  useAgsdlStore,
  type AgsdlSession,
} from "../../stores/useAgsdlStore";

const target = { branchName: "develop", planId: "field-test" };
const key = agsdlSessionKey(target);
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  useAgsdlStore.setState({ sessions: {} });
});

describe("AgSDL field buffers", () => {
  it("preserves uncommitted typing across remounts and refuses a stale apply", () => {
    const session: AgsdlSession = {
      source: "original",
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
      fieldDrafts: {},
    };
    useAgsdlStore.setState({ sessions: { [key]: session } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = () =>
      root!.render(
        <AgsdlDraftTarget.Provider value={target}>
          <JsonEditor
            draftKey="source"
            value={useAgsdlStore.getState().sessions[key].source}
            version={useAgsdlStore.getState().sessions[key].version}
            label="Source"
            readOnly={false}
            onApply={(source, version) =>
              useAgsdlStore
                .getState()
                .replace(target, source, undefined, version)
            }
          />
        </AgsdlDraftTarget.Provider>,
      );
    act(render);
    const textarea = container.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, "typing");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      useAgsdlStore.getState().sessions[key].fieldDrafts.source.value,
    ).toBe("typing");
    act(() => root!.render(null));
    act(() => useAgsdlStore.getState().replace(target, "new external value"));
    act(render);
    expect(container.querySelector("textarea")!.value).toBe("typing");
    act(() => container!.querySelectorAll("button")[0].click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "changed",
    );
    expect(useAgsdlStore.getState().sessions[key].source).toBe(
      "new external value",
    );
    act(() => container!.querySelectorAll("button")[1].click());
    expect(container.querySelector("textarea")!.value).toBe(
      "new external value",
    );
  });
});
