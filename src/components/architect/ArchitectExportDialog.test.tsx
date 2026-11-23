import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import type { BlueprintVersion, MacroProjectSettings } from "../../services/ipc/architectLibrary";
import { useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectDialogStore } from "../../stores/useArchitectDialogStore";
import { notify } from "../ui/toastService";
import { ArchitectExportDialog, exportFileName, nonDefaultSettings } from "./ArchitectExportDialog";
import {
  byText, click, createHost, defaultSettings, dialogText, flush, installNative, projectViewFixture, removeNative,
} from "./architectLibrary.testSupport";

const source = '{"contract":"agsdl-0.4.0","id":"x","agents":{}}';
let view: ReturnType<typeof createHost>;
let success: ReturnType<typeof spyOn<typeof notify, "success">>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let settings: MacroProjectSettings;
let picked: { save: string | null; open: string | null };
let exportFailure: unknown;

beforeEach(() => {
  calls = [];
  settings = defaultSettings;
  picked = { save: "/tmp/out/file.agsdl", open: "/tmp/out" };
  exportFailure = undefined;
  success = spyOn(notify, "success").mockReturnValue("toast");
  installNative(async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "architect_get_version": return { blueprintId: "bp", number: 3, revision: 4, note: null, storageState: "archive",
        project: projectViewFixture(source, { settings }) } satisfies Omit<BlueprintVersion, "document">;
      case "architect_get_draft": return { id: "bp", projectId: "p", name: "Revue", revision: 4, origin: null, archived: false,
        conversationId: null, history: null, project: projectViewFixture(source, { settings, revision: 4 }) };
      case "plugin:dialog|save": return picked.save;
      case "plugin:dialog|open": return picked.open;
      case "architect_export_archive": case "architect_export_project": if (exportFailure) throw exportFailure; return "ok";
      default: throw new Error(`Unexpected command ${command}`);
    }
  });
});
afterEach(() => {
  view?.unmount();
  removeNative();
  success.mockRestore();
  useAgsdlStore.setState({ sessions: {} });
  useArchitectDialogStore.setState({ dialog: null });
});

const mountVersion = async (format?: "archive" | "project", onClose = () => {}) => {
  view = createHost();
  await view.render(<ArchitectExportDialog onClose={onClose}
    dialog={{ kind: "export", target: { kind: "version", key: { blueprintId: "bp", number: 3 } }, name: "Revue de code", format }} />);
  await flush();
};
const mountDraft = async () => {
  view = createHost();
  await view.render(<ArchitectExportDialog onClose={() => {}} dialog={{ kind: "export", target: { kind: "draft", blueprintId: "bp" }, name: "Revue" }} />);
  await flush();
};
const choose = () => byText('[role="dialog"] footer button', "Choose location…")!;
const call = (command: string) => calls.find(entry => entry.command === command);

it("offers the archive and the folder for a version, and warns that Macro settings do not travel", async () => {
  await mountVersion();
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios).toHaveLength(2);
  expect(radios[0].checked).toBe(true);
  expect(dialogText()).toContain("Export version 3");
  expect(dialogText()).toContain("Archive (.agsdl)");
  expect(dialogText()).toContain("Project folder");
  expect(dialogText()).toContain("Macro’s own settings (hidden threads, etc.) are not included in the export.");
  expect(document.querySelector('[role="dialog"] details')?.textContent).toContain("AgSDL#32");
});

it("names what would be left behind when settings differ from their defaults", async () => {
  settings = { ...defaultSettings, hiddenAgentIds: ["a", "b"], entryMessageHint: "Describe the pull request" };
  await mountVersion();
  expect(dialogText()).toContain("not in the export: agents hidden in Operate, a hint for the starting message.");
  expect(dialogText()).not.toContain("Macro’s own settings (hidden threads, etc.)");
});

it("exports the archive to the chosen file, names it after the blueprint and announces it", async () => {
  picked.save = "/tmp/out/Revue de code-v3.agsdl";
  let closed = 0;
  await mountVersion(undefined, () => { closed++; });
  await click(choose());
  await flush();
  expect(call("plugin:dialog|save")?.args).toMatchObject({ options: { defaultPath: "Revue de code-v3.agsdl" } });
  expect(call("architect_export_archive")?.args).toEqual({ key: { blueprintId: "bp", number: 3 }, destination: "/tmp/out/Revue de code-v3.agsdl" });
  expect(success).toHaveBeenCalledWith("Version 3 exported", { description: "Revue de code-v3.agsdl" });
  expect(closed).toBe(1);
});

it("exports a folder named after the version inside the chosen parent folder", async () => {
  await mountVersion("project");
  expect(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].checked).toBe(true);
  await click(choose());
  await flush();
  expect(call("architect_export_project")?.args).toEqual({
    target: { kind: "version", key: { blueprintId: "bp", number: 3 } }, destination: "/tmp/out/Revue de code-v3" });
  expect(call("architect_export_archive")).toBeUndefined();
});

it("stays quietly open when the native dialog is cancelled", async () => {
  picked.save = null;
  let closed = 0;
  await mountVersion(undefined, () => { closed++; });
  await click(choose());
  await flush();
  expect(call("architect_export_archive")).toBeUndefined();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(success).not.toHaveBeenCalled();
  expect(closed).toBe(0);
  expect(choose().disabled).toBe(false);
});

it("never overwrites: an existing destination is reported plainly and the dialog stays open", async () => {
  exportFailure = { code: "ARCHITECT_PROJECT_ERROR", message: "x", details: { code: "DESTINATION_EXISTS", pointer: "", message: "exists" } };
  await mountVersion();
  await click(choose());
  await flush();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("This destination already exists");
  expect(success).not.toHaveBeenCalled();
  expect(choose().disabled).toBe(false);
});

it("exports a draft as a folder only and points to saving a version for a .agsdl file", async () => {
  await mountDraft();
  expect(dialogText()).toContain("Export the draft");
  expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(1);
  expect(dialogText()).toContain("A draft is not frozen, so it exports as a folder.");
  await click(choose());
  await flush();
  expect(call("plugin:dialog|save")).toBeUndefined();
  expect(call("architect_export_project")?.args).toMatchObject({ target: { kind: "draft", blueprintId: "bp" }, destination: "/tmp/out/Revue" });
  expect(success).toHaveBeenCalledWith("Draft exported", { description: "Revue" });
});

it("links a draft export to the save-version dialog", async () => {
  await mountDraft();
  await click(byText("button", "Save version", document.querySelector('[role="dialog"]')!));
  expect(useArchitectDialogStore.getState().dialog).toEqual({ kind: "saveVersion", blueprintId: "bp" });
});

it("builds file names from the blueprint name, never from an identifier", () => {
  expect(exportFileName("Revue de code", 3)).toBe("Revue de code-v3");
  expect(exportFileName('A/B:C*"D"', undefined)).toBe("A-B-C--D-");
  expect(exportFileName("  trailing dots...  ")).toBe("trailing dots");
  expect(exportFileName("\u0001\u0002", 1)).toBe("---v1");
  expect(exportFileName("   ", 2)).toBe("AgSDL-v2");
});

it("lists only the Macro settings that differ from their defaults", () => {
  expect(nonDefaultSettings(undefined)).toEqual([]);
  expect(nonDefaultSettings(defaultSettings)).toEqual([]);
  expect(nonDefaultSettings({ ...defaultSettings, hiddenAgentIds: ["a"], entryMessageHint: "h", workingFolderMode: "atLaunch", launchFields: {} }))
    .toEqual(["hidden", "hint", "folder", "fields"]);
});
