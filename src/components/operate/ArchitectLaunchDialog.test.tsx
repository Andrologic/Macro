import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ARCHIVE_RUN_PROJECT, type LaunchPreview, type LaunchRequest } from "../../services/ipc/architectLaunch";
import type { VersionKey } from "../../services/ipc/architectLibrary";
import { installTauriRuntimeMock, removeTauriRuntimeMock } from "../../test-utils/tauriRuntime";
import ArchitectLaunchDialog from "./ArchitectLaunchDialog";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const archive = { blueprintId: "blueprint", number: 1 };
const scope = { projectId: ARCHIVE_RUN_PROJECT, planId: archive.blueprintId, branch: "versions" };
const receipt = {
  identity: { systemStartId: "run", snapshotId: "snapshot" },
  source: { owner: scope, revision: "1", sourceSha256: "digest" },
};

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  removeTauriRuntimeMock();
});

async function show(version: VersionKey) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ArchitectLaunchDialog initialVersion={version} />); });
}

const dialog = () => document.querySelector("[role=dialog]")!;
const submit = () => dialog().querySelector<HTMLButtonElement>("button[type=submit]")!;

function install(invoke: (command: string, input: Record<string, unknown>) => unknown) {
  installTauriRuntimeMock(async (command, input) => {
    if (command === "architect_list_projects") return [{ id: "project", name: "Project" }];
    if (command === "architect_list_blueprints") return [{ id: archive.blueprintId, name: "System" }];
    if (command === "architect_list_versions") return [{ ...archive, storageState: "archive", note: null }];
    if (command === "architect_launch_run_systems") return [];
    return invoke(command, input as Record<string, unknown>);
  });
}

function preview(patch: Partial<LaunchPreview> = {}): LaunchPreview {
  return {
    version: archive, note: null, startMessageRequired: false, startMessageHint: null,
    workingFolderMode: "perExecution", configuration: { workingFolder: null }, folderReuseToken: null,
    blockers: [], secrets: [], availableModels: [], consentToken: null,
    permissions: {
      title: null, authoredId: "system", contract: "agsdl-0.4.0", packageFormat: "agsdl-archive-1",
      projectFormat: "agsdl-project-1", stagedSha256: "digest", historyWillBeRemoved: false, entryPoint: "entry",
      agents: {}, directCalls: [], mcpServers: {}, files: [], externalReferences: [], warnings: [],
    },
    ...patch,
  };
}

it("requires an explicit version when the just-saved version disappeared", async () => {
  const prepared: unknown[] = [];
  install((command, input) => {
    if (command !== "architect_launch_prepare") throw new Error(command);
    prepared.push(input.version);
    return preview();
  });
  await show({ ...archive, number: 2 });
  expect(dialog().querySelector("[role=alert]")?.textContent).toContain("Version 2");
  expect(submit().disabled).toBe(true);
  expect(prepared).toEqual([]);
  await act(async () => {
    const select = dialog().querySelector("select")!;
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(prepared).toEqual([archive]);
  expect(submit().disabled).toBe(false);
});

it("shows the completion command and when it runs before sending consent", async () => {
  const consentToken = "permission-review";
  const current = preview({ consentToken });
  current.permissions.agents.worker = {
    usage: "reachable", harness: "codex", harnessVersion: null, model: null, mcpServers: [],
    permissions: { preset: "workspace", directories: {}, outside: null, reviewer: null, rules: [] },
    completionCheck: "echo verify", completionCheckChoices: ["done", "retry"],
  };
  const requests: LaunchRequest[] = [];
  install((command, input) => {
    if (command === "architect_launch_prepare") return current;
    if (command === "architect_launch_start") { requests.push(input.request as LaunchRequest); return receipt; }
    throw new Error(command);
  });
  await show(archive);
  await act(async () => submit().click());
  expect(requests).toEqual([]);
  expect(dialog().textContent).toContain("After the agent submits one of these choices: done, retry.");
  expect(dialog().querySelector("code")?.textContent).toBe("echo verify");
  await act(async () => submit().click());
  expect(requests[0].consentToken).toBe(consentToken);
});

it("rechecks when the folder becomes occupied and requires an explicit confirmation", async () => {
  const requests: LaunchRequest[] = [];
  install((command, input) => {
    if (command === "architect_launch_prepare") return preview({
      folderReuseToken: requests.length > 0 ? `folder-identity-${requests.length}` : null,
      workingFolderMode: "atLaunch", configuration: { workingFolder: "/workspace" },
    });
    if (command === "architect_launch_start") {
      requests.push(input.request as LaunchRequest);
      if (requests.length === 1) throw { code: "WORKING_FOLDER_IN_USE" };
      if (requests.length === 2) throw { code: "WORKING_FOLDER_CHANGED" };
      return receipt;
    }
    throw new Error(command);
  });
  await show(archive);
  await act(async () => submit().click());
  expect(requests.map(request => request.folderReuseToken)).toEqual([null]);
  expect(submit().disabled).toBe(true);
  const checkbox = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => checkbox.click());
  expect(submit().disabled).toBe(false);
  await act(async () => submit().click());
  expect(requests.map(request => request.folderReuseToken)).toEqual([null, "folder-identity-1"]);
  expect(submit().disabled).toBe(true);
  expect(checkbox.checked).toBe(false);
  await act(async () => checkbox.click());
  await act(async () => submit().click());
  expect(requests.map(request => request.folderReuseToken)).toEqual([null, "folder-identity-1", "folder-identity-2"]);
});

it("applies the selected replacement model to this launch", async () => {
  const requests: LaunchRequest[] = [];
  install((command, input) => {
    if (command === "architect_launch_prepare") return preview({
      availableModels: ["available-model"], blockers: Object.keys(input.modelOverrides ?? {}).length
        ? [] : [{ code: "modelUnavailable", subject: "worker" }],
    });
    if (command === "architect_launch_start") {
      requests.push(input.request as LaunchRequest);
      return receipt;
    }
    throw new Error(command);
  });
  await show(archive);
  expect(submit().disabled).toBe(true);
  const models = [...dialog().querySelectorAll("select")].find(select => select.textContent?.includes("available-model"))!;
  await act(async () => {
    models.value = "available-model";
    models.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(submit().disabled).toBe(false);
  await act(async () => submit().click());
  expect(requests[0].modelOverrides).toEqual({ worker: { name: "available-model" } });
});
