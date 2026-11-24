import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { ARCHIVE_RUN_PROJECT, type LaunchConfiguration, type LaunchPreview, type LaunchRequest } from "../../../services/ipc/architectLaunch";
import { workflowRunTargetSnapshot030 } from "../../../services/workflowAgentTasks";
import { useAppStore } from "../../../stores/useAppStore";
import { useArchitectLaunchStore } from "../../../stores/useArchitectLaunchStore";
import { byText, click, createHost, fillField, flush, installNative, removeNative } from "../../architect/architectLibrary.testSupport";
import { notify } from "../../ui/toastService";
import ArchitectLaunchDialog from "../ArchitectLaunchDialog";

const archive = { blueprintId: "bp", number: 2 };
const scope = { projectId: ARCHIVE_RUN_PROJECT, planId: "bp", branch: "versions" };
const receipt = { identity: { systemStartId: "run-1", snapshotId: "snap" }, source: { owner: scope, revision: "2", sourceSha256: "digest" } };

let view: ReturnType<typeof createHost>;
let startHandler: () => unknown = () => receipt;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let actionRequired: ReturnType<typeof spyOn<typeof notify, "actionRequired">>;
const initialLaunch = useArchitectLaunchStore.getState();

function preview(patch: Partial<LaunchPreview> = {}): LaunchPreview {
  return {
    version: archive, note: "Added the reviewer", startMessageRequired: false, startMessageHint: null,
    workingFolderMode: "perExecution", configuration: { workingFolder: null }, folderReuseToken: null,
    blockers: [], secrets: [], availableModels: [], consentToken: null,
    agentMcp: {}, remoteMcp: {}, remoteMcpSetup: {}, mcpDirectTools: {}, mcpNotes: [],
    permissions: {
      title: null, authoredId: "system", contract: "agsdl-0.4.0", packageFormat: "agsdl-archive-1", projectFormat: "agsdl-project-1",
      stagedSha256: "digest", historyWillBeRemoved: false, entryPoint: "entry", agents: {}, directCalls: [], mcpServers: {},
      files: [], externalReferences: [], warnings: [],
    },
    ...patch,
  };
}

function install(prepare: (input: Record<string, unknown>) => LaunchPreview | Promise<LaunchPreview>, extra: (command: string, args: Record<string, unknown>) => unknown = () => { throw new Error("unexpected"); }) {
  installNative(async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "architect_list_projects": return [{ id: "p", name: "Project" }];
      case "architect_list_blueprints": return [{ id: "bp", name: "Code review" }];
      case "architect_list_versions": return [
        { blueprintId: "bp", number: 1, storageState: "archive", note: null },
        { blueprintId: "bp", number: 2, storageState: "archive", note: "Added the reviewer" },
      ];
      case "architect_launch_prepare": return prepare(args);
      case "architect_launch_run_systems": return [];
      case "architect_launch_start": return startHandler();
      default: return extra(command, args);
    }
  });
}

const show = async (version: typeof archive | null = archive) => {
  view = createHost();
  await view.render(<ArchitectLaunchDialog initialVersion={version ?? undefined} />);
  await flush();
};
const dialog = () => document.querySelector('[role="dialog"]')!;
const primary = () => dialog().querySelector<HTMLButtonElement>("footer button.is-primary")!;
const started = () => calls.filter(call => call.command === "architect_launch_start").map(call => call.args.request as LaunchRequest);

beforeEach(() => {
  calls = [];
  startHandler = () => receipt;
  actionRequired = spyOn(notify, "actionRequired").mockReturnValue("toast");
  useArchitectLaunchStore.setState({ window: { version: archive } });
});
afterEach(() => {
  view?.unmount();
  removeNative();
  actionRequired.mockRestore();
  useArchitectLaunchStore.setState(initialLaunch);
});

it("names the system in the title and summarizes version, place and moment on one line", async () => {
  install(() => preview());
  await show();
  expect(dialog().querySelector("header strong")?.textContent).toBe("Launch “Code review”");
  const summary = dialog().querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(summary.textContent).toContain("Version 2");
  expect(summary.textContent).toContain("This machine");
  expect(summary.textContent).toContain("Now");
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(dialog().textContent).not.toContain("Added the reviewer");
  expect(dialog().textContent).not.toContain("Working folder");
});

it("opens the editable details: version and note, this machine, now, an optional run name", async () => {
  install(() => preview());
  await show();
  await click(dialog().querySelector("button[aria-expanded]"));
  expect(dialog().textContent).toContain("Added the reviewer");
  expect(dialog().textContent).toContain("Where");
  expect(dialog().textContent).toContain("When");
  const options = [...dialog().querySelectorAll("select option")].map(option => option.textContent);
  expect(options[0]).toContain("Version 2 · latest");
  await fillField(dialog().querySelector<HTMLInputElement>("input")!, "Friday review");
  await click(primary());
  expect(started()[0].name).toBe("Friday review");
});

it("marks a version that is not the latest in the summary", async () => {
  install(args => preview({ version: args.version as typeof archive }));
  await show({ ...archive, number: 1 });
  expect(dialog().querySelector("button[aria-expanded]")?.textContent).toContain("Version 1 (older)");
});

it("shows the author's hint with a required start message and blocks launching until it is written", async () => {
  install(() => preview({ startMessageRequired: true, startMessageHint: "Describe the repository and the branch to review." }));
  await show();
  expect(dialog().textContent).toContain("Author’s hint: Describe the repository and the branch to review.");
  expect(dialog().querySelector("textarea")?.getAttribute("placeholder")).toBeNull();
  expect(primary().disabled).toBe(true);
  expect(primary().title).toBe("Write a start message.");
  await fillField(dialog().querySelector("textarea")!, "Review main");
  expect(primary().disabled).toBe(false);
  await click(primary());
  expect(started()[0].startMessage).toBe("Review main");
});

it("hides the start message when the system needs none, and sends none", async () => {
  install(() => preview({ startMessageRequired: false, startMessageHint: "ignored" }));
  await show();
  expect(!!dialog().querySelector("textarea")).toBe(false);
  await click(primary());
  expect(started()[0].startMessage).toBeNull();
});

it("asks for a missing secret in place, never shows its value, and releases the launch once it is stored", async () => {
  let stored = false;
  const permissions = preview().permissions;
  permissions.mcpServers.github = {
    usage: "reachable", transport: { type: "local", command: ["sh", "serve.sh"] },
    packagedFiles: ["serve.sh"], requiredSecrets: ["GITHUB_TOKEN"],
  };
  install(() => preview({ permissions, secrets: [{ server: "github", name: "GITHUB_TOKEN", stored, legacyResetRequired: !stored }] }), (command, args) => {
    if (command !== "architect_launch_set_secret") throw new Error(command);
    stored = true;
    expect(args).toMatchObject({ server: "github", name: "GITHUB_TOKEN", value: "ghp_secret" });
    return undefined;
  });
  await show();
  expect(dialog().textContent).toContain("Before you launch");
  expect(dialog().textContent).toContain("The tool “github” needs “GITHUB_TOKEN”.");
  expect(dialog().textContent).toContain("Macro could not verify where the old secret was used.");
  expect(dialog().textContent).toContain("If its command, arguments, or packaged files change, enter the secret again and approve the new version.");
  expect(primary().disabled).toBe(true);
  expect(primary().title).toBe("1 thing left to settle.");
  const field = dialog().querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(field.autocomplete).toBe("off");
  await fillField(field, "ghp_secret");
  await click(byText("button", "Save secret", dialog()));
  await flush();
  expect(dialog().textContent).toContain("“GITHUB_TOKEN” saved.");
  expect(dialog().textContent).not.toContain("ghp_secret");
  expect(dialog().textContent).not.toContain("Before you launch");
  expect(primary().disabled).toBe(false);
});

it("keeps what was typed and says so when a secret cannot be saved", async () => {
  install(() => preview({ secrets: [{ server: "github", name: "GITHUB_TOKEN", stored: false }] }), () => { throw { code: "VAULT" }; });
  await show();
  await fillField(dialog().querySelector('input[type="password"]')!, "value");
  await click(byText("button", "Save secret", dialog()));
  await flush();
  expect(dialog().querySelector("[role=alert]")?.textContent).toBe("Macro could not save this secret.");
  expect(dialog().querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("value");
});

it("offers a replacement picker for a missing model and keeps the choice out of the version", async () => {
  install(args => preview({
    availableModels: ["model-a", "model-b"],
    blockers: Object.keys(args.modelOverrides ?? {}).length ? [] : [{ code: "modelUnavailable", subject: "reviewer" }],
  }));
  await show();
  expect(dialog().textContent).toContain("The model of the agent “reviewer” is not available.");
  expect(dialog().textContent).toContain("This choice applies to this run only. It is not saved in the version.");
  expect(primary().disabled).toBe(true);
  const picker = dialog().querySelector<HTMLSelectElement>('select[aria-label="Replacement model for reviewer"]')!;
  await act(async () => { picker.value = "model-b"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  expect(primary().disabled).toBe(false);
  // The choice stays reachable in the details once the problem is gone.
  await click(dialog().querySelector("button[aria-expanded]"));
  expect(dialog().textContent).toContain("Models replaced for this run");
  expect(dialog().textContent).toContain("The model of the agent “reviewer” is replaced.");
  await click(primary());
  expect(started()[0].modelOverrides).toEqual({ reviewer: { name: "model-b" } });
});

it("says plainly when the engine offers no other model", async () => {
  install(() => preview({ availableModels: [], blockers: [{ code: "modelUnavailable", subject: "reviewer" }] }));
  await show();
  expect(dialog().textContent).toContain("The engine offers no other model right now.");
  expect(!!dialog().querySelector('select[aria-label^="Replacement model"]')).toBe(false);
});

it("asks for a working folder, shows the chosen one in the summary and checks it again", async () => {
  const prepared: unknown[] = [];
  install(args => {
    prepared.push(args.configuration);
    const chosen = (args.configuration as { workingFolder: string } | null)?.workingFolder ?? null;
    return preview({ workingFolderMode: "atLaunch", configuration: { workingFolder: chosen },
      blockers: chosen ? [] : [{ code: "workingFolderRequired", subject: "" }] });
  }, command => { if (command === "plugin:dialog|open") return "/home/me/project"; throw new Error(command); });
  await show();
  expect(dialog().textContent).toContain("Choose the folder this system will work in.");
  expect(dialog().querySelector("button[aria-expanded]")?.textContent).toContain("No folder chosen");
  expect(primary().disabled).toBe(true);
  await click(byText("button", "Choose a folder", dialog()));
  await flush();
  expect(prepared.at(-1)).toEqual({ workingFolder: "/home/me/project" });
  expect(dialog().querySelector("button[aria-expanded]")?.textContent).toContain("project");
  expect(primary().disabled).toBe(false);
});

it("keeps the launch closed until the person confirms a folder another run already uses", async () => {
  install(() => preview({ workingFolderMode: "atLaunch", configuration: { workingFolder: "/home/me/project" }, folderReuseToken: "token" }));
  await show();
  expect(dialog().textContent).toContain("Another active run uses this folder.");
  expect(dialog().textContent).toContain("/home/me/project");
  expect(primary().disabled).toBe(true);
  await click(dialog().querySelector('input[type="checkbox"]'));
  expect(primary().disabled).toBe(false);
  await click(primary());
  expect(started()[0].folderReuseToken).toBe("token");
});

it("explains tool problems in plain words, with the code on demand and no way to fix them here", async () => {
  install(() => preview({ blockers: [{ code: "mcpIsolationUnavailable", subject: "github" }] }));
  await show();
  const text = dialog().textContent ?? "";
  expect(text).toContain("Macro cannot run the tool “github” in a protected space on this computer");
  expect(text).toContain("Only the author of this system can change this, in Architect.");
  expect(text).not.toContain("MCP");
  expect(dialog().querySelector("details")?.textContent).toContain("mcpIsolationUnavailable · github");
  expect(primary().disabled).toBe(true);
});

it("explains the supported Codex version on macOS and links to installation instructions", async () => {
  install(() => preview({
    blockers: [{ code: "codexUnavailable", subject: "CODEX_VERSION_UNQUALIFIED", codexPlatform: "macosArm64" }],
  }));
  await show();
  expect(dialog().textContent).toContain("Install the complete official Codex 0.167.x package");
  expect(dialog().textContent).not.toContain("0.171.0");
  expect(dialog().textContent).not.toContain("Connect…");
  const guide = byText("a", "Codex installation guide", dialog());
  expect(guide?.getAttribute("href")).toEndWith("/docs/agsdl-codex-native.md");
  expect(dialog().querySelector("details")?.textContent).toContain("CODEX_VERSION_UNQUALIFIED");
  expect(primary().disabled).toBe(true);
});

it("sends a Codex login requirement to the private sign-in guide", async () => {
  install(() => preview({ blockers: [{ code: "codexUnavailable", subject: "CODEX_LOGIN_REQUIRED" }] }));
  await show();
  expect(dialog().textContent).toContain("Sign in to Codex through Macro’s private profile");
  const guide = byText("a", "Private sign-in guide", dialog());
  expect(guide?.getAttribute("href")).toEndWith("#private-login");
});

const remoteEndpoint = "https://mcp.example.com/issues";
const remotePermissions: LaunchPreview["permissions"] = {
  ...preview().permissions,
  mcpServers: {
    issues: { transport: { type: "remote", url: remoteEndpoint }, usage: "reachable", requiredSecrets: ["ISSUES_TOKEN"], packagedFiles: [] },
  },
  externalReferences: [{ kind: "mcpEndpoint", uri: remoteEndpoint, location: { file: "mcp/issues.json", pointer: "/url" }, usage: "reachable" }],
};

it("shows the remote MCP endpoint and declared credentials when the runtime cannot use the server", async () => {
  install(() => preview({
    blockers: [{ code: "mcpRemoteUnsupported", subject: "issues" }],
    permissions: remotePermissions,
  }));
  await show();
  expect(dialog().textContent).toContain("This version of Macro cannot use the remote tool server “issues”");
  expect(dialog().textContent).toContain(remoteEndpoint);
  expect(dialog().textContent).toContain("ISSUES_TOKEN");
  expect(dialog().querySelector('input[type="password"]')).toBeNull();
  expect(primary().disabled).toBe(true);
});

it("shows the endpoint, credential delivery and tool decisions before consent", async () => {
  install(() => preview({
    consentToken: "review",
    permissions: remotePermissions,
    remoteMcp: { issues: { url: remoteEndpoint, addressScope: "public", delivery: { ISSUES_TOKEN: "Authorization: Bearer" } } },
    agentMcp: { reviewer: { issues: {
      equipped: true, default: "deny", tools: { read: "allow", lookup: "ask", remove: "deny" },
      agentDefault: "deny", agentPatterns: {}, hostDefault: "allow", hostPatterns: {},
    } } },
  }));
  await show();
  expect(primary().textContent).toBe("Continue");
  await click(primary());
  expect(started()).toEqual([]);
  expect(dialog().querySelector("header strong")?.textContent).toBe("What this system can do");
  expect(dialog().textContent).toContain("Step 2 of 2 · Code review · Version 2 · This machine");
  expect(dialog().textContent).toContain("You have not approved what this version can do yet");
  expect(dialog().textContent).toContain(remoteEndpoint);
  expect(dialog().textContent).toContain("ISSUES_TOKEN is sent as a Bearer token.");
  expect(dialog().textContent).toContain("Allowed addresses · Public internet");
  expect(dialog().textContent).toContain("reviewer");
  expect(dialog().textContent).toContain("read · Allowed");
  expect(dialog().textContent).toContain("lookup · Approval required");
  expect(dialog().textContent).toContain("remove · Denied");
  expect(primary().textContent).toBe("Allow and launch");
  await click(byText("button", "Back", dialog()));
  expect(dialog().querySelector("header strong")?.textContent).toBe("Launch “Code review”");
  await click(primary());
  await click(primary());
  expect(started()[0].consentToken).toBe("review");
});

it("shows unused MCP diagnostics before consent without blocking or listing unused servers in consent", async () => {
  install(() => preview({
    consentToken: "review",
    mcpNotes: [{ server: "issues", unsupportedEndpoint: true }, { server: "spare", unsupportedEndpoint: false }],
    mcpDirectTools: { alerts: ["lookup"] },
    permissions: {
      ...remotePermissions,
      mcpServers: {
        ...remotePermissions.mcpServers,
        alerts: { transport: { type: "remote", url: "https://example.invalid/alerts" }, usage: "declaredOnly", requiredSecrets: [], packagedFiles: [] },
      },
      directCalls: [{ target: { type: "mcp", server: "alerts", tool: "lookup" }, location: { file: "flow.json", pointer: "/steps/check" }, usage: "declaredOnly" }],
    },
  }));
  await show();
  expect(dialog().textContent).toContain("“issues” has an unsupported endpoint and will not be connected.");
  expect(dialog().textContent).toContain("No agent uses the tools of “spare”, so it will not be connected.");
  expect(primary().disabled).toBe(false);
  await click(primary());
  expect(dialog().textContent).toContain("alerts");
  expect(dialog().textContent).toContain("lookup");
  expect(dialog().textContent).not.toContain("issues");
  expect(dialog().textContent).not.toContain("spare");
  await click(primary());
  expect(started()).toHaveLength(1);
});

it("requires explicit delivery choices and sends the selected header to launch", async () => {
  const suggestions = { ISSUES_TOKEN: { type: "bearer" }, CLIENT_TOKEN: { type: "header", name: "X-Client-Token" } } as const;
  install(args => {
    const configuration = (args.configuration as LaunchConfiguration | null) ?? { workingFolder: null };
    const delivery = configuration.remoteMcp?.issues[remoteEndpoint]?.delivery;
    const complete = !!delivery?.ISSUES_TOKEN && !!delivery.CLIENT_TOKEN;
    return preview({
      configuration,
      permissions: remotePermissions,
      consentToken: complete ? "explicit-delivery" : null,
      blockers: complete ? [] : [{ code: "mcpSecretDeliveryRequired", subject: "issues" }],
      remoteMcpSetup: { issues: { url: remoteEndpoint, addressScope: "public", suggestions } },
      remoteMcp: complete ? { issues: { url: remoteEndpoint, addressScope: "public", delivery: { ISSUES_TOKEN: "Authorization: Bearer", CLIENT_TOKEN: "x-team-key" } } } : {},
    });
  });
  await show();
  expect(primary().disabled).toBeTrue();
  await act(async () => dialog().querySelectorAll("fieldset form")[0].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
  expect(primary().disabled).toBeTrue();
  await fillField(dialog().querySelector('input[aria-label="HTTP header for CLIENT_TOKEN"]')!, "X-Team-Key");
  await act(async () => dialog().querySelectorAll("fieldset form")[1].dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
  expect(primary().disabled).toBeFalse();
  await click(primary());
  expect(dialog().textContent).toContain("CLIENT_TOKEN is sent in the “x-team-key” header.");
  await click(primary());
  expect(started()[0].configuration.remoteMcp?.issues[remoteEndpoint].delivery).toEqual({
    ISSUES_TOKEN: { type: "bearer" }, CLIENT_TOKEN: { type: "header", name: "X-Team-Key" },
  });
});

it("explains the connection form in plain words, and does not repeat the address in the blocker beside it", async () => {
  install(() => preview({
    permissions: remotePermissions,
    blockers: [{ code: "mcpPrivateNetworkRequired", subject: "issues" }],
    remoteMcpSetup: { issues: { url: remoteEndpoint, addressScope: "public", suggestions: { ISSUES_TOKEN: { type: "bearer" } } } },
  }));
  await show();
  const form = dialog().querySelector("fieldset")!;
  expect(form.textContent).toContain("Connection to issues");
  expect(form.textContent).toContain("Allowed addresses");
  expect(form.textContent).toContain("Macro only connects to addresses of this kind: the internet, your local network, or this computer.");
  expect([...form.querySelectorAll("select")[0].options].map(option => option.textContent)).toEqual(["Public internet", "Local network", "This computer"]);
  expect(form.textContent).toContain("How to send ISSUES_TOKEN");
  // The sentence names the control to change; the address and the secret names are in the form, once.
  expect(dialog().textContent).toContain("is on a local network. Set “Allowed addresses” above to “Local network”");
  expect(dialog().textContent!.split(remoteEndpoint)).toHaveLength(2);
  expect(dialog().textContent).not.toContain("Declared credentials");
  // A named header asks for its name, with a hint of what to type.
  const delivery = form.querySelectorAll("select")[1];
  await act(async () => { delivery.value = "header"; delivery.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(form.querySelector<HTMLInputElement>('input[aria-label="HTTP header for ISSUES_TOKEN"]')?.placeholder).toBe("Header name");
});

it("shows each tool rule of an agent with its effect, and what applies to every other tool", async () => {
  install(() => preview({
    consentToken: "review", permissions: remotePermissions,
    remoteMcp: { issues: { url: remoteEndpoint, addressScope: "public", delivery: { ISSUES_TOKEN: "Authorization: Bearer" } } },
    agentMcp: { reviewer: { issues: {
      equipped: true, default: "deny", tools: { read: "allow", lookup: "ask", remove: "deny" },
      agentDefault: "deny", agentPatterns: {}, hostDefault: "allow", hostPatterns: {},
    } } },
  }));
  await show();
  await click(primary());
  const rows = [...dialog().querySelectorAll("li")].map(item => item.textContent);
  expect(rows).toContain("read · Allowed");
  expect(rows).toContain("lookup · Approval required");
  expect(rows).toContain("remove · Denied");
  expect(rows).toContain("Every other tool · Denied");
  // The effect is an icon as well as a word, never colour alone.
  expect(dialog().querySelectorAll("li svg").length).toBeGreaterThanOrEqual(4);
  expect(dialog().textContent).toContain("ISSUES_TOKEN is sent as a Bearer token.");
});

it("asks for consent to the selected network scope even for a server with no credentials", async () => {
  install(args => {
    const configuration = (args.configuration as LaunchConfiguration | null) ?? { workingFolder: null };
    const addressScope = configuration.remoteMcp?.issues[remoteEndpoint]?.addressScope ?? "public";
    return preview({
      configuration,
      remoteMcpSetup: { issues: { url: remoteEndpoint, addressScope, suggestions: {} } },
      remoteMcp: { issues: { url: remoteEndpoint, addressScope, delivery: {} } },
      consentToken: addressScope === "privateNetwork" ? "private-addresses" : null,
    });
  });
  await show();
  const scope = dialog().querySelector("fieldset select") as HTMLSelectElement;
  expect(scope.value).toBe("public");
  await act(async () => {
    scope.value = "privateNetwork";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  await click(primary());
  expect(dialog().textContent).toContain("Allowed addresses · Local network");
  expect(started()).toEqual([]);
  await click(primary());
  expect(started()[0].consentToken).toBe("private-addresses");
  expect(started()[0].configuration.remoteMcp?.issues[remoteEndpoint].addressScope).toBe("privateNetwork");
});

it("keeps the credential entry and consent separate for a new endpoint", async () => {
  let stored = false;
  install(args => {
    const version = args.version as typeof archive;
    const url = version.number === 2 ? remoteEndpoint + "?tenant=new" : remoteEndpoint;
    return preview({
      version, permissions: remotePermissions,
      consentToken: version.number === 2 ? "new-endpoint-consent" : null,
      remoteMcp: { issues: { url, addressScope: "public", delivery: { ISSUES_TOKEN: "Authorization: Bearer" } } },
      secrets: [{ server: "issues", name: "ISSUES_TOKEN", stored }],
    });
  }, (command, args) => {
    expect(command).toBe("architect_launch_set_secret");
    expect(args).toEqual({ version: archive, server: "issues", name: "ISSUES_TOKEN", value: "synthetic-secret", configuration: { workingFolder: null } });
    stored = true;
  });
  await show();
  const input = dialog().querySelector('input[type="password"]')!;
  expect(primary().disabled).toBe(true);
  await fillField(input, "synthetic-secret");
  await click(byText("button", "Save secret", dialog()));
  await flush();
  expect(dialog().querySelector('input[type="password"]')).toBeNull();
  expect(started()).toEqual([]);
  await click(primary());
  expect(dialog().textContent).toContain("?tenant=new");
  expect(dialog().textContent).not.toContain("synthetic-secret");
  await click(primary());
  expect(started()[0].consentToken).toBe("new-endpoint-consent");
  expect(JSON.stringify(started())).not.toContain("synthetic-secret");
});

/** The official AgSDL review project: a read-only reviewer lists the `issues` server and is never given its tools. */
const reviewerAgent = (patch: Partial<LaunchPreview["permissions"]["agents"][string]> = {}): LaunchPreview["permissions"]["agents"][string] => ({
  usage: "reachable", harness: "codex", harnessVersion: null, model: null, mcpServers: ["issues"], completionCheck: null,
  permissions: { preset: "read-only", directories: {}, outside: null, reviewer: null, rules: [] }, ...patch,
});
const unequipped = { reviewer: { issues: {
  equipped: false, default: "deny", tools: {},
  agentDefault: "deny", agentPatterns: {}, hostDefault: "allow", hostPatterns: {},
} } } as const;

it("omits the endpoint and credentials when the reviewer has no MCP tools, and says why in plain words", async () => {
  install(() => preview({
    consentToken: "review", permissions: { ...remotePermissions, agents: { reviewer: reviewerAgent() } },
    mcpNotes: [{ server: "issues", unsupportedEndpoint: false }],
    agentMcp: unequipped,
  }));
  await show();
  expect(dialog().querySelector('input[type="password"]')).toBeNull();
  expect(dialog().textContent).toContain("No agent is allowed to use the tools of “issues” in this run, so it will not be connected.");
  // The reason per agent is one click away, not on the surface.
  const why = byText("summary", "Why?", dialog())!;
  expect(why.parentElement!.hasAttribute("open")).toBe(false);
  await click(why);
  expect(dialog().textContent).toContain("reviewer: it can only read, so it is given no tools.");
  expect(dialog().textContent).toContain("allow them in the agent’s permissions in Architect");
  await click(primary());
  expect(dialog().textContent).not.toContain("issues");
  expect(dialog().textContent).not.toContain("ISSUES_TOKEN");
  expect(dialog().textContent).not.toContain(remoteEndpoint);
});

it.each([
  ["a Claude Code agent", reviewerAgent({ harness: "claude-code" }), "reviewer: its engine (Claude Code) does not offer tools here."],
  ["an agent that may write", reviewerAgent({ permissions: { preset: "workspace", directories: {}, outside: null, reviewer: null, rules: [{ action: "mcp", match: "issues", effect: "deny" }] } }), "reviewer: its permissions do not allow tools."],
  ["an agent the flow never reaches", reviewerAgent({ usage: "declaredOnly" }), "reviewer: the flow never hands work to it."],
])("tells why the tools of an unused server are off for %s", async (_name, agent, line) => {
  install(() => preview({
    permissions: { ...remotePermissions, agents: { reviewer: agent } },
    mcpNotes: [{ server: "issues", unsupportedEndpoint: false }], agentMcp: unequipped,
  }));
  await show();
  await click(byText("summary", "Why?", dialog()));
  expect(dialog().textContent).toContain(line);
});

it("tells the policy of this computer apart from what the author wrote", async () => {
  install(() => preview({
    permissions: { ...remotePermissions, agents: { reviewer: reviewerAgent({ permissions: { preset: "workspace", directories: {}, outside: null, reviewer: null, rules: [] } }) } },
    mcpNotes: [{ server: "issues", unsupportedEndpoint: false }],
    agentMcp: { reviewer: { issues: { ...unequipped.reviewer.issues, agentDefault: "ask", hostDefault: "deny" } } },
  }));
  await show();
  await click(byText("summary", "Why?", dialog()));
  expect(dialog().textContent).toContain("reviewer: the launch policy of this computer does not allow tools.");
});

it("says a declared server no agent lists is simply not used", async () => {
  install(() => preview({ permissions: { ...remotePermissions, agents: {} }, mcpNotes: [{ server: "issues", unsupportedEndpoint: false }] }));
  await show();
  expect(dialog().textContent).toContain("No agent uses the tools of “issues”, so it will not be connected.");
  expect(!!byText("summary", "Why?", dialog())).toBe(false);
});

const only = (patch: Partial<LaunchPreview["permissions"]["agents"][string]>) => ({ ...preview().permissions, agents: { writer: reviewerAgent({ mcpServers: [], model: { name: "gpt-5.2", effort: null }, ...patch }) } });

it.each([
  ["declared but absent from the flow", "declaredOnly"],
  ["declared in a system that has no flow", "unknown"],
] as const)("warns before launching, and again in consent, when the only agent is %s", async (_name, usage) => {
  install(() => preview({ consentToken: "review", permissions: only({ usage }) }));
  await show();
  const warning = dialog().querySelector('section[aria-label="No agent will run"]')!;
  expect(warning.textContent).toContain("never hands work to them: launching it would not run any agent");
  expect(primary().disabled).toBe(false);
  await click(primary());
  // Consent keeps the warning, and lists no engine or model for an agent that will not run.
  expect(dialog().querySelector('section[aria-label="No agent will run"]')).not.toBeNull();
  expect(dialog().textContent).not.toContain("Codex");
  expect(dialog().textContent).not.toContain("gpt-5.2");
});

it("names the agents a flow does not reach when others do take part, and stays silent when all are reached", async () => {
  const permissions = { ...preview().permissions, agents: { writer: reviewerAgent({ mcpServers: [] }), spare: reviewerAgent({ mcpServers: [], usage: "declaredOnly" }) } };
  install(() => preview({ permissions }));
  await show();
  expect(dialog().querySelector('section[aria-label="1 agent will not run"]')?.textContent).toContain("never hands work to: spare");
  view.unmount();
  install(() => preview({ permissions: { ...permissions, agents: { writer: permissions.agents.writer } } }));
  await show();
  expect(dialog().textContent).not.toContain("will not run");
});

it("announces the launch with an action, and opens nothing by itself", async () => {
  install(() => preview({ startMessageRequired: true }));
  await show();
  await fillField(dialog().querySelector("textarea")!, "Private details");
  await click(primary());
  await flush();
  expect(useArchitectLaunchStore.getState().window).toBeNull();
  expect(actionRequired).toHaveBeenCalledTimes(1);
  const [title, options] = actionRequired.mock.calls[0];
  expect(title).toBe("Run launched");
  expect(options.description).toBe("Code review · Version 2");
  expect(JSON.stringify(options)).not.toContain("Private details");
  expect(options.actions?.map(action => action.label)).toEqual(["View run"]);
  expect(workflowRunTargetSnapshot030()).toBeNull();
  await act(async () => { void options.actions?.[0].onClick?.(); });
  expect(workflowRunTargetSnapshot030()?.scope.systemStartId).toBe("run-1");
});

it("shows a launch failure in the window, keeps the input and lets the person try again", async () => {
  let fail = true;
  install(() => preview({ startMessageRequired: true }));
  startHandler = () => { if (fail) { fail = false; throw { code: "ENGINE_DOWN" }; } return receipt; };
  await show();
  await fillField(dialog().querySelector("textarea")!, "Review main");
  await click(primary());
  await flush();
  expect(dialog().querySelector("[role=alert]")?.textContent).toContain("Macro could not complete the operation.");
  expect(dialog().querySelector("details")?.textContent).toContain("ENGINE_DOWN");
  expect(dialog().querySelector("textarea")?.value).toBe("Review main");
  expect(primary().disabled).toBe(false);
  expect(actionRequired).not.toHaveBeenCalled();
  await click(primary());
  await flush();
  expect(actionRequired).toHaveBeenCalledTimes(1);
});

it("shows a loading state while systems are listed, then an empty state with a way to Architect", async () => {
  let release: (value: unknown) => void = () => {};
  installNative(async command => {
    if (command === "architect_list_projects") return new Promise(resolve => { release = resolve; });
    if (command === "architect_list_blueprints") return [{ id: "bp", name: "Draft only" }];
    if (command === "architect_list_versions") return [];
    throw new Error(command);
  });
  await show(null);
  expect(dialog().querySelector("[role=status]")?.textContent).toContain("Checking…");
  expect(primary().disabled).toBe(true);
  await act(async () => release([{ id: "p", name: "Project" }]));
  await flush();
  expect(dialog().textContent).toContain("No system is ready to launch. Save a version in Architect first.");
  const mode = spyOn(useAppStore.getState(), "setMode").mockReturnValue(undefined);
  await click(byText("button", "Open Architect", dialog()));
  expect(mode).toHaveBeenCalledWith("Architect");
  mode.mockRestore();
});

it("offers a retry when the systems cannot be listed", async () => {
  let fail = true;
  installNative(async command => {
    if (command === "architect_list_projects") { if (fail) throw new Error("down"); return []; }
    throw new Error(command);
  });
  await show(null);
  expect(dialog().querySelector("[role=alert]")?.textContent).toContain("Macro could not list your systems.");
  fail = false;
  await click(byText("button", "Retry", dialog()));
  await flush();
  expect(!!dialog().querySelector("[role=alert]")).toBe(false);
});

it("shows a recoverable error when the check itself fails", async () => {
  let fail = true;
  install(() => { if (fail) throw { code: "SOMETHING" }; return preview(); });
  await show();
  expect(dialog().querySelector("[role=alert]")?.textContent).toContain("Macro could not complete the operation.");
  expect(primary().disabled).toBe(true);
  expect(dialog().querySelector("footer")?.textContent).toContain("Check again to continue.");
  expect(!!dialog().querySelector('[data-spinner-icon="true"]')).toBe(false);
  fail = false;
  await click(byText("button", "Check again", dialog()));
  await flush();
  expect(!!dialog().querySelector("[role=alert]")).toBe(false);
  expect(primary().disabled).toBe(false);
});

it("opens with no system chosen when it was not opened for a version, and starts nothing until one is picked", async () => {
  install(() => preview());
  await show(null);
  const field = dialog().querySelector<HTMLInputElement>('input[aria-label="System"]')!;
  expect(field.value).toBe("");
  expect(field.placeholder).toBe("Choose a system");
  expect(calls.some(call => call.command === "architect_launch_prepare")).toBe(false);
  expect(primary().disabled).toBe(true);
  expect(dialog().querySelector("footer")?.textContent).toContain("Choose a system to start.");
  // The list is searchable and has no “none” row: a choice is required.
  await act(async () => { field.focus(); });
  await fillField(field, "zzz");
  expect(document.body.textContent).toContain("No system matches your search.");
  await fillField(field, "review");
  const option = byText("button", "Code review", document.body.querySelector("[data-macro-dialog-portal]")!)!;
  expect(document.body.querySelector("[data-macro-dialog-portal]")?.textContent).not.toContain("No Group");
  await click(option);
  await flush();
  expect(calls.filter(call => call.command === "architect_launch_prepare")).toHaveLength(1);
  expect(primary().disabled).toBe(false);
});

it("keeps the version it was opened for: no picker, the check starts at once", async () => {
  install(() => preview());
  await show();
  expect(!!dialog().querySelector('input[aria-label="System"]')).toBe(false);
  expect(calls.filter(call => call.command === "architect_launch_prepare")).toHaveLength(1);
  expect(primary().disabled).toBe(false);
});
