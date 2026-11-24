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
const submit = () => dialog().querySelector<HTMLButtonElement>("button.is-primary")!;

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
    agentMcp: {}, remoteMcp: {}, remoteMcpSetup: {}, mcpDirectTools: {}, mcpNotes: [],
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
    completionCheck: "echo verify", completionCheckChoices: ["done", "retry"], completionCheckMaxFailures: "3",
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
  expect(dialog().textContent).toContain("Failure limit 3.");
  expect(dialog().textContent).toContain("Step 2 of 2");
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

it.each([
  ["CODEX_AUTH_VERSION_UNQUALIFIED", "Use Codex 0.167.0 for file authentication", "#explicit-existing-file-authentication"],
  ["CODEX_LOGIN_REQUIRED", "Sign in to Codex through Macro’s private profile", "#private-login"],
])("shows how to resolve %s when Codex auth changes at launch", async (code, guidance, anchor) => {
  let blocked = false;
  install((command) => {
    if (command === "architect_launch_prepare") return preview({
      blockers: blocked ? [{ code: "codexUnavailable", subject: code }] : [],
    });
    if (command === "architect_launch_start") {
      blocked = true;
      throw { code };
    }
    throw new Error(command);
  });
  await show(archive);
  await act(async () => submit().click());
  expect(dialog().textContent).toContain(guidance);
  expect(dialog().querySelector("a")?.hash).toBe(anchor);
  expect(dialog().querySelector("a")?.pathname).toBe("/Andrologic/Macro/blob/main/docs/agsdl-codex-native.md");
  expect(submit().disabled).toBe(true);
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

it("preserves the file and pointer when a reserved secret prevents archive preview", async () => {
  install(command => {
    if (command !== "architect_launch_prepare") throw new Error(command);
    throw {
      code: "MCP_SECRET_RESERVED",
      source: { path: "secrets.json", pointer: "/worker/0" },
    };
  });
  await show(archive);
  const alert = dialog().querySelector("[role=alert]")?.textContent;
  expect(alert).toContain("This project declares a reserved MCP secret name.");
  expect(alert).toContain("secrets.json#/worker/0");
  expect(submit().disabled).toBe(true);
});

it("explains the approval scope and flags interpreter environment secrets", async () => {
  const current = preview({
    consentToken: "permission-review",
    mcpDirectTools: { worker: ["call"] },
    secrets: [
      { server: "worker", name: "HOME", stored: true },
      { server: "worker", name: "NODE_OPTIONS", stored: true },
      { server: "worker", name: "API_TOKEN", stored: true },
    ],
  });
  current.permissions.directCalls.push({
    usage: "reachable", location: { file: "agsdl.json", pointer: "/flow/steps/call" },
    target: { type: "mcp", server: "worker", tool: "call" },
  });
  current.permissions.mcpServers.worker = {
    usage: "reachable", transport: { type: "local", command: ["serve"] },
    packagedFiles: ["serve"], requiredSecrets: ["HOME", "NODE_OPTIONS", "API_TOKEN"],
  };
  install(command => {
    if (command === "architect_launch_prepare") return current;
    throw new Error(command);
  });
  await show(archive);
  await act(async () => submit().click());
  const text = dialog().textContent;
  expect(text).toContain("Your approval covers the code of the tools shipped with this system and the files they declare.");
  expect(text).toContain("It does not cover files in your working folder that a tool might read or run");
  expect(text).toContain("The tool “worker” receives the secret HOME.");
  expect(text).toContain("The tool “worker” receives the secret NODE_OPTIONS.");
  expect(text).toContain("Environment variables · HOME, NODE_OPTIONS, API_TOKEN");
  expect(text).not.toContain("The tool “worker” receives the secret API_TOKEN.");
});
