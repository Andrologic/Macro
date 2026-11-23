import { afterEach, beforeEach, expect, it } from "bun:test";
import { useArchitectDialogStore } from "../../stores/useArchitectDialogStore";
import { ArchitectRecoveryCard } from "./ArchitectRecoveryCard";
import { byText, click, createHost, flush, installNative, removeNative } from "./architectLibrary.testSupport";

let view: ReturnType<typeof createHost>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
beforeEach(() => {
  calls = [];
  installNative(async (command, args) => {
    calls.push({ command, args });
    if (command === "plugin:dialog|save") return "/tmp/original.json";
    return undefined;
  });
});
afterEach(() => {
  view?.unmount();
  removeNative();
  useArchitectDialogStore.setState({ dialog: null });
});
const mount = async (props: Partial<Parameters<typeof ArchitectRecoveryCard>[0]> = {}) => {
  view = createHost();
  await view.render(<ArchitectRecoveryCard blueprintId="bp" name="Revue de code" projectId="p" number={1} revision={2}
    diagnostics={[{ code: "MISSING_FILE", file: "agents/relecteur.json", pointer: "/instructions", message: "file not found" }]} {...props} />);
};

it("explains calmly that nothing is lost and offers repair or download, never export or launch", async () => {
  await mount();
  const card = document.querySelector("[data-recovery-card]")!;
  expect(card.textContent).toContain("Revue de code · version 1");
  expect(card.textContent).toContain("This version could not be recovered");
  expect(card.textContent).toContain("Its content is kept");
  expect(card.textContent).toContain("Item concerned: Agent “relecteur”");
  expect(card.textContent?.toLowerCase()).not.toContain("corrupt");
  const buttons = [...card.querySelectorAll("button")].map(button => button.textContent?.trim()).filter(Boolean);
  expect(buttons).toEqual(expect.arrayContaining(["Adapt for repair", "Download original", "Delete…"]));
  expect(buttons.some(label => /export|launch/i.test(label ?? ""))).toBe(false);
  // The raw reason is behind the technical details, not in the headline.
  const headline = card.cloneNode(true) as HTMLElement;
  headline.querySelectorAll("details").forEach(details => details.remove());
  expect(headline.textContent).not.toContain("agents/relecteur.json");
  expect(card.querySelector("details")?.textContent).toContain("MISSING_FILE · agents/relecteur.json#/instructions · file not found");
});

it("adapts a recovery version through the shared adapt dialog in repair mode", async () => {
  await mount();
  await click(byText("button", "Adapt for repair"));
  expect(useArchitectDialogStore.getState().dialog).toEqual({
    kind: "adapt", name: "Revue de code", projectId: "p", repair: true, source: { kind: "version", key: { blueprintId: "bp", number: 1 } } });
});

it("adapts a recovery draft by blueprint, since it has no version number", async () => {
  await mount({ number: null });
  expect(document.querySelector("[data-recovery-card]")?.textContent).toContain("Revue de code · draft");
  expect(document.querySelector("[data-recovery-card]")?.textContent).toContain("This draft could not be recovered");
  await click(byText("button", "Adapt for repair"));
  expect(useArchitectDialogStore.getState().dialog).toMatchObject({ source: { kind: "recoveryDraft", blueprintId: "bp" } });
  expect(byText("button", "Delete…")).toBeUndefined();
});

it("downloads the stored original exactly, without an intermediate dialog", async () => {
  await mount();
  await click(byText("button", "Download original"));
  await flush();
  expect(calls.find(call => call.command === "plugin:dialog|save")?.args).toMatchObject({ options: { defaultPath: "Revue de code-v1.json" } });
  expect(calls.find(call => call.command === "architect_export_original_envelope")?.args)
    .toEqual({ blueprintId: "bp", revision: 2, number: 1, destination: "/tmp/original.json" });
  expect(useArchitectDialogStore.getState().dialog).toBeNull();
});

it("offers deleting an entry that can never be used by a run", async () => {
  await mount();
  await click(byText("button", "Delete…"));
  expect(useArchitectDialogStore.getState().dialog).toEqual({ kind: "deleteVersion", key: { blueprintId: "bp", number: 1 } });
});
